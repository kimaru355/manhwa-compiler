'use strict';

const fs = require('fs');
const { once } = require('events');

// Acrobat refuses pages larger than this many points; long webtoon strips get scaled down to fit.
const MAX_PAGE_UNITS = 14400;

function pdfTextString(text) {
  const buf = Buffer.from('﻿' + text, 'utf16le');
  buf.swap16();
  return '<' + buf.toString('hex') + '>';
}

function readJpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  let adobe = false;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; }
    const len = buf.readUInt16BE(pos + 2);
    if (marker === 0xee && buf.toString('latin1', pos + 4, pos + 9) === 'Adobe') adobe = true;
    if (marker >= 0xc0 && marker <= 0xc2) {
      return {
        height: buf.readUInt16BE(pos + 5),
        width: buf.readUInt16BE(pos + 7),
        components: buf[pos + 9],
        adobe,
      };
    }
    pos += 2 + len;
  }
  throw new Error('no usable JPEG frame header');
}

// Streams a PDF to disk one image-page at a time, so memory use stays flat
// no matter how many pages the manhwa has. JPEG data is embedded as-is (no re-encoding).
class PdfWriter {
  constructor(finalPath) {
    this.finalPath = finalPath;
    this.tempPath = finalPath + '.part';
    this.stream = fs.createWriteStream(this.tempPath);
    this.error = null;
    this.stream.on('error', (e) => { this.error = e; });
    this.offset = 0;
    this.offsets = new Map();
    this.nextId = 4; // 1 = catalog, 2 = page tree, 3 = outlines
    this.pageIds = [];
    this.outline = [];
    this.pendingBookmark = null;
  }

  get pageCount() {
    return this.pageIds.length;
  }

  async open() {
    await this._write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  }

  // The next page added gets a bookmark with this title.
  bookmark(title) {
    this.pendingBookmark = title;
  }

  async addImage({ data, width, height, components, adobe }) {
    const scale = Math.min(1, MAX_PAGE_UNITS / Math.max(width, height));
    const w = +(width * scale).toFixed(2);
    const h = +(height * scale).toFixed(2);
    const imgId = this.nextId++;
    const contentId = this.nextId++;
    const pageId = this.nextId++;

    const colorSpace = components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const decode = components === 4 && adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    await this._object(
      imgId,
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode${decode} /Length ${data.length} >>`,
      data
    );
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    await this._object(contentId, `<< /Length ${content.length} >>`, content);
    await this._object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );

    if (this.pendingBookmark !== null) {
      this.outline.push({ title: this.pendingBookmark, pageId });
      this.pendingBookmark = null;
    }
    this.pageIds.push(pageId);
  }

  async close() {
    const kids = this.pageIds.map((id) => `${id} 0 R`).join(' ');
    await this._object(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pageIds.length} >>`);

    let catalogExtra = '';
    if (this.outline.length) {
      const ids = this.outline.map(() => this.nextId++);
      await this._object(3, `<< /Type /Outlines /First ${ids[0]} 0 R /Last ${ids[ids.length - 1]} 0 R /Count ${ids.length} >>`);
      for (let i = 0; i < ids.length; i++) {
        const prev = i > 0 ? ` /Prev ${ids[i - 1]} 0 R` : '';
        const next = i < ids.length - 1 ? ` /Next ${ids[i + 1]} 0 R` : '';
        await this._object(
          ids[i],
          `<< /Title ${pdfTextString(this.outline[i].title)} /Parent 3 0 R${prev}${next} /Dest [${this.outline[i].pageId} 0 R /Fit] >>`
        );
      }
      catalogExtra = ' /Outlines 3 0 R /PageMode /UseOutlines';
    } else {
      await this._object(3, '<< /Type /Outlines /Count 0 >>');
    }
    await this._object(1, `<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`);

    const xrefOffset = this.offset;
    const size = this.nextId;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let id = 1; id < size; id++) {
      xref += String(this.offsets.get(id)).padStart(10, '0') + ' 00000 n \n';
    }
    xref += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    await this._write(xref);

    this.stream.end();
    await once(this.stream, 'finish');
    await fs.promises.rename(this.tempPath, this.finalPath);
  }

  async abort() {
    if (!this.stream.closed) {
      const closed = once(this.stream, 'close').catch(() => {});
      this.stream.destroy();
      await closed;
    }
    await fs.promises.unlink(this.tempPath).catch(() => {});
  }

  async _object(id, dict, stream) {
    this.offsets.set(id, this.offset);
    await this._write(`${id} 0 obj\n${dict}\n`);
    if (stream !== undefined) {
      await this._write('stream\n');
      await this._write(stream);
      await this._write('\nendstream\n');
    }
    await this._write('endobj\n');
  }

  async _write(data) {
    if (this.error) throw this.error;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    this.offset += buf.length;
    if (!this.stream.write(buf)) await once(this.stream, 'drain');
    if (this.error) throw this.error;
  }
}

module.exports = { PdfWriter, readJpegInfo };

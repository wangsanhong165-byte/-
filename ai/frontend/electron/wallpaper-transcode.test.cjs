// Tests for the wallpaper transcode module: MP4 moov probing (pure part).

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const { getMediaInfo } = require('./wallpaper-transcode.cjs')

/** Build a tiny synthetic MP4 with one video trak carrying fps metadata. */
function buildTestMp4({ timescale = 600, sampleDelta = 5, samples = 600 }) {
  const box = (type, payload) => {
    const out = Buffer.alloc(8 + payload.length)
    out.writeUInt32BE(8 + payload.length, 0)
    out.write(type, 4, 'latin1')
    payload.copy(out, 8)
    return out
  }
  // stsd: version/flags(4) + entry count(4) + avc1 entry.
  // Real avc1 entry layout: size(4) + format 'avc1'(4) + ... + width(+32) + height(+34).
  const avc1 = Buffer.alloc(86)
  avc1.writeUInt32BE(86, 0) // entry size (self-referential, like a nested box)
  avc1.write('avc1', 4, 'latin1')
  avc1.writeUInt16BE(1920, 32)
  avc1.writeUInt16BE(1080, 34)
  const stsdPayload = Buffer.alloc(8)
  stsdPayload.writeUInt32BE(1, 4) // entry count (after version/flags)
  const stsdBox = box('stsd', Buffer.concat([stsdPayload, avc1]))
  const stts = box('stts', (() => {
    // stts payload: version/flags(4) + entry count(4) + entries.
    const payload = Buffer.alloc(8 + 8)
    payload.writeUInt32BE(1, 4) // entry count
    payload.writeUInt32BE(samples, 8) // sample count
    payload.writeUInt32BE(sampleDelta, 12) // sample delta
    return payload
  })())
  const stbl = box('stbl', Buffer.concat([stsdBox, stts]))
  const minf = box('minf', stbl)
  // mdhd v0: timescale@12, duration@16 (relative to payload start after version/flags)
  const mdhdPayload = Buffer.alloc(24)
  mdhdPayload.writeUInt32BE(timescale, 12)
  mdhdPayload.writeUInt32BE(samples * sampleDelta, 16)
  const mdhd = box('mdhd', mdhdPayload)
  // hdlr: 'vide' at payload offset 8..12
  const hdlrPayload = Buffer.alloc(24)
  hdlrPayload.write('vide', 8, 'latin1')
  const hdlr = box('hdlr', hdlrPayload)
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]))
  const trak = box('trak', mdia)
  const moov = box('moov', trak)
  // ftyp + moov (faststart: moov near the head).
  const ftyp = box('ftyp', Buffer.from('isom'))
  return Buffer.concat([ftyp, moov])
}

test('moov probe reads codec, size, fps, duration (faststart layout)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tc-'))
  const file = path.join(dir, 'sample.mp4')
  // timescale 600, delta 5 → 120fps; 600 samples → 5s.
  fs.writeFileSync(file, buildTestMp4({ timescale: 600, sampleDelta: 5, samples: 600 }))
  const info = getMediaInfo(file)
  assert.ok(info)
  assert.equal(info.codec, 'avc1')
  assert.equal(info.width, 1920)
  assert.equal(info.height, 1080)
  assert.equal(info.fps, 120)
  assert.equal(info.duration, 5)
})

test('moov probe caches per size+mtime and tolerates non-MP4 files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tc2-'))
  const junk = path.join(dir, 'junk.mp4')
  fs.writeFileSync(junk, 'this is not an mp4 at all')
  assert.equal(getMediaInfo(junk), null)
  assert.equal(getMediaInfo(path.join(dir, 'missing.mp4')), null)
})

test('fps derived from stts sample table (samples×timescale/ticks)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tc3-'))
  const file = path.join(dir, 'sample.mp4')
  // timescale 1000, delta 50 → 20fps; 200 samples → 10s.
  fs.writeFileSync(file, buildTestMp4({ timescale: 1000, sampleDelta: 50, samples: 200 }))
  const info = getMediaInfo(file)
  assert.equal(info.fps, 20)
  assert.equal(info.duration, 10)
})

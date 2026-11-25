import { describe, expect, it } from 'vitest';
import { inspectMediaBuffer, isValidImageMagic } from '../security/file-guard.js';
import { isPrivateOrReservedIp, SsrfBlockedError, validateOutboundUrl } from '../security/ssrf.js';

describe('SSRF Guard', () => {
  it('identifies private, loopback, link-local, CGNAT and IPv6 ULA addresses', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.20.30.40')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.10')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('100.64.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true);

    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
  });

  it('blocks disallowed outbound URLs', async () => {
    await expect(validateOutboundUrl('http://127.0.0.1:4000/test.mp3')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateOutboundUrl('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(validateOutboundUrl('http://localhost/audio.wav')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateOutboundUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateOutboundUrl('https://user:pass@example.com/a.mp3')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('File Guard (magic bytes)', () => {
  it('accepts valid WAV, FLAC, MP3, MP4/M4A, OGG and WebM headers', () => {
    const wav = Buffer.from('524946462400000057415645', 'hex');
    expect(inspectMediaBuffer(wav, 'sample.wav')).toEqual({ valid: true, detectedFormat: 'wav' });

    const flac = Buffer.from('664c614300000022', 'hex');
    expect(inspectMediaBuffer(flac, 'track.flac')).toEqual({ valid: true, detectedFormat: 'flac' });

    const mp3 = Buffer.from('4944330300000000', 'hex');
    expect(inspectMediaBuffer(mp3, 'song.mp3')).toEqual({ valid: true, detectedFormat: 'mp3' });

    const mp4 = Buffer.from('000000206674797069736f6d', 'hex');
    expect(inspectMediaBuffer(mp4, 'audio.m4a')).toEqual({ valid: true, detectedFormat: 'm4a' });
  });

  it('rejects disguised executables, HTML scripts and unsupported extensions', () => {
    const exe = Buffer.from('4d5a900003000000', 'hex');
    expect(inspectMediaBuffer(exe, 'evil.mp3').valid).toBe(false);

    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect(inspectMediaBuffer(html, 'fake.wav').valid).toBe(false);

    const wav = Buffer.from('524946462400000057415645', 'hex');
    expect(inspectMediaBuffer(wav, 'script.exe').valid).toBe(false);
  });

  it('validates JPEG/PNG/WebP cover image magic bytes', () => {
    expect(isValidImageMagic(Buffer.from('ffd8ffe00010', 'hex'))).toBe('jpeg');
    expect(isValidImageMagic(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe('png');
    expect(isValidImageMagic(Buffer.from('<html>bad</html>'))).toBeNull();
  });
});

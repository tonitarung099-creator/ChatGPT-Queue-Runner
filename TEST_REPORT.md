# Test Report — ChatGPT Queue Runner v0.2.0

Tanggal: 28 September 2026

## Pengujian otomatis / simulasi

Pengujian berikut dijalankan terhadap sumber v0.2.0 sebelum paket dikirim ke branch GitHub:

- `node --test tests/*.test.js` → **29 lulus, 0 gagal**.
- `node scripts/validate-packages.mjs` → **10 paket Runner konsisten** dan manifest v0.2.0 valid.
- `node --check` dijalankan pada seluruh JavaScript di `src/` dan `extensions/` → **lulus**.
- Seluruh 10 `manifest.json` berhasil diparse sebagai JSON dan mempunyai versi **0.2.0**.

Regression suite mencakup kontrak B01–B18 yang dapat diuji deterministik/simulasi: cancellation Jeda/Reset, stale revision, identitas percakapan, acceptance yang kuat, anti-duplikat, journal sebelum klik, recovery state, outcome interrupted/failed, approval guard, sinkronisasi popup, owner recovery, draft popup, serta koordinasi lintas runner secara kontrak. B19 diperiksa melalui dokumentasi/generator distribusi.

## Chromium / Load unpacked

Lingkungan pengembangan memiliki Chromium dan proses headless berhasil dimulai dengan `--load-extension` terhadap paket Runner. Namun target service worker/aktivasi ekstensi tidak dapat diverifikasi secara positif dari harness headless yang tersedia. Karena itu hasil ini **tidak diklaim sebagai lulus integrasi Chrome Load unpacked penuh**.

## ChatGPT live

**Belum dilakukan pengiriman prompt ke akun ChatGPT nyata.** Tidak ada klaim bahwa T29/T30 atau seluruh selector UI ChatGPT saat ini sudah lulus live smoke test.

## Yang masih perlu diuji langsung

- Load unpacked manual Runner 01–10 pada Chrome desktop.
- Dua ekstensi Runner pada tab yang sama dan pada dua tab berbeda.
- Reload tab, restart Chrome/service worker, background tab/sleep/wake.
- ChatGPT bahasa Indonesia/Inggris, chat panjang, tool/file/image output, project/custom GPT.
- Launcher lokal nyata pada port 47651/47652, termasuk `commandId`/acknowledgement dari server launcher.

## Interpretasi

Lulusnya unit/simulation/source-contract test berarti invariant kode yang diuji bekerja pada harness lokal. Itu bukan bukti bahwa DOM/selector ChatGPT atau perilaku Chrome MV3 tidak akan berubah di produksi.

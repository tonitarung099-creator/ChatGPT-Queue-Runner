# ChatGPT Queue Runner

Versi **0.2.0** — 10 Chrome extension terpisah: Runner 01–10.

Rilis ini mengimplementasikan hardening B01–B19 dari audit Astra: cancellation Jeda/Reset, journal pengiriman, identitas percakapan, pencegahan prompt ganda, deteksi outcome jujur, approval guard, recovery owner tab, sinkronisasi popup/launcher, penyimpanan draf, koordinasi lintas runner, generator paket, dan regression tests.

## Instalasi

Setiap folder `extensions/chat-queue-runner-01` … `chat-queue-runner-10` dapat dipasang melalui **Load unpacked** di `chrome://extensions`.

## Outcome

- `completed`: jawaban normal selesai.
- `interrupted`: jawaban terhenti; runner menunggu jeda lalu lanjut.
- `failed`: kegagalan eksplisit/Try again; runner menunggu jeda lalu lanjut.
- `unknown`: status tidak cukup pasti; runner tidak mengaku sukses dan tidak retry buta.
- Permintaan izin/konfirmasi selalu menjeda sampai pengguna bertindak.

## Pengembangan

`src/` adalah sumber kanonik. Jalankan `node scripts/generate-runners.mjs` untuk menyinkronkan 10 paket, lalu `node --test tests/*.test.js` dan `node scripts/validate-packages.mjs`.

Laporan uji harus membedakan simulasi/fixture, integrasi Chrome Load unpacked, dan ChatGPT live. Jangan menganggap `node --check` sebagai bukti perilaku live.

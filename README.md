# ChatGPT Queue Runner

Kumpulan 10 Chrome extension (Runner 01–10) untuk menjalankan antrean prompt satu per satu di ChatGPT Web.

## Versi

Saat ini: **v0.1.7**

Perbaikan v0.1.7:
- Reset sekarang benar-benar menghentikan runner di tab ChatGPT.
- Prompt diverifikasi sudah diterima ChatGPT sebelum antrean maju, agar tidak menggantung atau mengirim ganda.
- Penyelesaian jawaban memakai indikator selesai dan stabilitas teks sebagai fallback.
- Runner tidak mengganggu jawaban manual yang sedang berjalan.
- Widget Runner 01–10 punya ID/posisi terpisah bila beberapa runner aktif pada tab yang sama.

## Struktur

- `extensions/chat-queue-runner-01/`
- `extensions/chat-queue-runner-02/`
- `extensions/chat-queue-runner-03/`
- `extensions/chat-queue-runner-04/`
- `extensions/chat-queue-runner-05/`
- `extensions/chat-queue-runner-06/`
- `extensions/chat-queue-runner-07/`
- `extensions/chat-queue-runner-08/`
- `extensions/chat-queue-runner-09/`
- `extensions/chat-queue-runner-10/`

Masing-masing folder dapat dimuat sebagai **Load unpacked** di `chrome://extensions`.

## Cara pakai

1. Buka `chrome://extensions`.
2. Aktifkan **Developer mode**.
3. Klik **Load unpacked**.
4. Pilih salah satu folder runner di dalam `extensions/`.
5. Buka `https://chatgpt.com/` dan jalankan antrean dari popup extension.

## Catatan

Extension menggunakan Manifest V3 dan menyimpan antrean secara lokal melalui `chrome.storage.local`.

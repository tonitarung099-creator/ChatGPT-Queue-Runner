# Chat Queue Runner

Versi **0.2.0**. Folder ini adalah salah satu Runner 01–10 dan dapat dipasang langsung melalui **Load unpacked**.

## Perilaku penting

- Prompt dikirim satu per satu dan baru dianggap diterima setelah user-turn yang cocok muncul.
- **Jeda** dan **Reset** membatalkan aksi yang belum diklik. Reset tidak membiarkan callback lama menghidupkan sesi baru.
- Sesi terikat ke tab + identitas percakapan. Pindah chat membuat antrean dijeda.
- Draf manual di composer tidak ditimpa.
- Jawaban normal dicatat `completed`. Jawaban yang benar-benar terhenti dicatat `interrupted`, kegagalan eksplisit dicatat `failed`; keduanya lanjut ke prompt berikut setelah jeda.
- Jika ChatGPT meminta **izin/konfirmasi**, antrean dijeda dan tombol izin tidak diklik otomatis.
- Status pengiriman ambigu tidak dikirim ulang otomatis untuk menghindari prompt ganda.
- Runner berbeda pada tab yang sama memakai lease + Web Locks. Jika tab sudah dikuasai runner lain, runner kedua dijeda.
- Draf daftar prompt di popup disimpan terpisah dari antrean aktif.

## Instalasi

1. Ekstrak ZIP distribusi.
2. Buka `chrome://extensions` dan aktifkan **Developer mode**.
3. Klik **Load unpacked**.
4. Pilih folder `chat-queue-runner-01` sampai `chat-queue-runner-10` yang ingin dipasang.
5. Setelah update ekstensi, muat ulang tab ChatGPT sebelum menjalankan antrean.

## Batas yang perlu diketahui

Kompatibilitas selector ChatGPT dapat berubah karena UI web bukan API stabil. Pengujian otomatis repo memakai fixture/simulasi dan tidak sama dengan smoke test langsung di akun ChatGPT. Background tab yang ditidurkan Chrome, restart service worker, serta server launcher lokal perlu diuji lagi pada lingkungan pengguna.

Endpoint launcher lokal `127.0.0.1` tetap dipertahankan untuk kompatibilitas. Payload baru dapat membawa `commandId` agar replay dapat ditolak; server launcher lama yang belum mengirim `commandId` tetap diterima tetapi tidak mendapat jaminan de-duplication end-to-end.

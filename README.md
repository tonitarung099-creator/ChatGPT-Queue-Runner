# ChatGPT Queue Runner

Versi **v0.1.8**. Paket berisi Runner 01–10.

Perbaikan utama: Reset benar-benar menghentikan runner, prompt diverifikasi diterima ChatGPT, deteksi jawaban selesai lebih aman, dan runner tidak mengganggu generasi manual yang sedang berjalan.

## Otomatis lanjut saat ChatGPT berhenti

Mulai **v0.1.8**, Runner tidak lagi berhenti hanya karena jawaban ChatGPT terpotong. Jika UI menampilkan **Continue generating**, **Try again / Retry**, atau **Regenerate**, item aktif diperlakukan sebagai jawaban yang sudah berhenti. Runner menunggu jeda yang kamu atur, lalu bergerak ke prompt berikutnya. Konfirmasi/izin pengguna tetap menjeda antrean.

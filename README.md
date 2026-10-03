# Studio Edit

Bộ công cụ xử lý video: tách phụ đề, cắt video, chuyển đổi định dạng, phân cảnh theo phụ đề, làm sạch metadata.
Cùng một mã nguồn chạy được ở hai dạng:

| | Bản web | Bản Windows |
|---|---|---|
| Xử lý video | FFmpeg.wasm trong trình duyệt | `ffmpeg.exe` gốc (đa luồng, NVENC/QSV/AMF) |
| File đầu vào | Đọc qua trình duyệt | Đọc trực tiếp từ ổ đĩa |
| Groq API key | Biến môi trường `GROQ_API_KEY` trên máy chủ | Người dùng nhập trong **Cài đặt** |
| Triển khai | Vercel | Bộ cài `.exe` |

## Bản web

```bash
npm install
echo "GROQ_API_KEY=gsk_..." > .env.local   # key Groq của bạn
npm run dev                        # http://localhost:3000
```

Deploy lên Vercel như một dự án Next.js bình thường và khai báo `GROQ_API_KEY` trong
Project Settings → Environment Variables.

## Bản Windows (Electron)

```bash
npm run desktop:dev    # tải FFmpeg (lần đầu), build server, mở app
npm run desktop:dist   # tạo bộ cài: dist-desktop/StudioEdit-Setup-<version>.exe
```

- `desktop:ffmpeg` tải `ffmpeg.exe`/`ffprobe.exe` (bản build của gyan.dev) vào `desktop/bin/`.
- `desktop:build-web` build Next.js dạng standalone (`STUDIO_DESKTOP=1`) và **không** đóng gói
  file `.env*` hay API key của bạn vào bộ cài.
- `desktop:start` mở app từ bản build hiện có.

Cấu trúc:

- `desktop/main.cjs` – tiến trình chính: chạy server Next.js nội bộ, chạy FFmpeg, lưu cài đặt
  (`%APPDATA%/Studio Edit/settings.json`).
- `desktop/preload.cjs` – cầu nối `window.studioDesktop` cho giao diện (kiểu dữ liệu ở `app/_lib/desktop.ts`).
- `app/_lib/ffmpeg.ts` – `MediaEngine`: tự chọn FFmpeg.wasm (web) hoặc FFmpeg gốc (Windows).

## Thêm công cụ mới

Tạo `app/<route>/page.tsx` rồi thêm một mục vào `app/_components/nav-config.ts`; công cụ tự xuất hiện ở
menu bên trái, ô tìm kiếm và trang Tổng quan. Dùng các hàm trong `app/_lib/ffmpeg.ts` để xử lý video là
tự động chạy được trên cả hai bản.

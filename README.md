# Studio Edit

Bộ công cụ xử lý video: tách phụ đề, cắt video, chuyển đổi định dạng, phân cảnh theo phụ đề, làm sạch metadata,
tạo giọng nói từ văn bản.
Cùng một mã nguồn chạy được ở hai dạng:

| | Bản web | Bản Windows |
|---|---|---|
| Xử lý video | FFmpeg.wasm trong trình duyệt | `ffmpeg.exe` gốc (đa luồng, NVENC/QSV/AMF) |
| File đầu vào | Đọc qua trình duyệt | Đọc trực tiếp từ ổ đĩa |
| Groq API key | Biến môi trường `GROQ_API_KEY` trên máy chủ | Người dùng nhập trong **Cài đặt** |
| Tạo giọng nói | Mô hình lưu trong Cache Storage của trình duyệt | Mô hình lưu trong `%APPDATA%/Studio Edit/models` |
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

## Tạo giọng nói (Supertonic 3)

Công cụ `/text-to-speech` dùng [Supertonic 3](https://github.com/supertone-oss-archive/supertonic) (31 ngôn ngữ,
có tiếng Việt, 10 giọng mẫu, thẻ biểu cảm `<laugh>`, `<breath>`, `<sigh>`) và chạy hoàn toàn trên máy người dùng:

- Lần đầu dùng, trình duyệt tải mô hình (~380 MB) từ Hugging Face (`supertone-oss-archive/supertonic-3`, cố định
  theo revision) rồi lưu lại; các lần sau không cần tải nữa. Nút **Xóa mô hình đã tải** trên trang để giải phóng dung lượng.
- Suy luận chạy trong Web Worker bằng onnxruntime-web (WebGPU, tự lùi về WebAssembly), nạp từ jsDelivr lúc chạy.
  Gói `onnxruntime-web` trong devDependencies chỉ dùng cho kiểu TypeScript; khi nâng cấp, sửa luôn `ORT_URL`
  trong `app/_lib/tts/tts.worker.ts`.
- Mã nguồn: `app/_lib/tts/supertonic.ts` (pipeline, chuyển từ `web/helper.js` của repo gốc), `tts.worker.ts`,
  `client.ts` (tải và lưu mô hình, quản lý worker).
- Giấy phép: mã mẫu MIT, mô hình OpenRAIL-M (© Supertone Inc.).

## Thêm công cụ mới

Tạo `app/<route>/page.tsx` rồi thêm một mục vào `app/_components/nav-config.ts`; công cụ tự xuất hiện ở
menu bên trái, ô tìm kiếm và trang Tổng quan. Dùng các hàm trong `app/_lib/ffmpeg.ts` để xử lý video là
tự động chạy được trên cả hai bản.

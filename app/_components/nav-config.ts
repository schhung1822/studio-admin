import type { IconSource } from "@shopify/polaris";
import { ExchangeIcon, HomeIcon, ImagesIcon, PlayCircleIcon, SettingsIcon, ShieldCheckMarkIcon, SoundIcon, TextBlockIcon } from "@shopify/polaris-icons";

export interface NavItem {
  label: string;
  url: string;
  icon: IconSource;
  /** Shown on the overview page. */
  description?: string;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

/**
 * Sidebar menu. To add a new tool: create `app/<route>/page.tsx` and add an item here —
 * it automatically appears in the sidebar, the sidebar search and the overview page.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [{ label: "Tổng quan", url: "/", icon: HomeIcon }],
  },
  {
    title: "Video & Âm thanh",
    items: [
      {
        label: "Tách phụ đề",
        url: "/subtitles",
        icon: TextBlockIcon,
        description: "Tách âm thanh từ video MP4 ngay trên trình duyệt và tạo phụ đề .srt bằng Groq Whisper.",
      },
      {
        label: "Cắt video",
        url: "/video-splitter",
        icon: PlayCircleIcon,
        description: "Chia video thành nhiều đoạn theo mốc thời gian bạn chọn, hoặc chia đều theo độ dài/số phần.",
      },
      {
        label: "Chuyển đổi định dạng",
        url: "/video-converter",
        icon: ExchangeIcon,
        description: "Đổi video sang MP4, MOV, MKV, WebM, AVI, GIF hoặc tách âm thanh MP3/M4A/WAV. Hỗ trợ nhiều file cùng lúc.",
      },
      {
        label: "Tách âm thanh",
        url: "/audio-extractor",
        icon: SoundIcon,
        description:
          "Lấy riêng âm thanh từ video: giữ nguyên chất lượng gốc hoặc xuất MP3, M4A, OGG, WAV, FLAC. Chọn track, cắt đoạn, chuẩn hóa âm lượng.",
      },
      {
        label: "Phân cảnh theo phụ đề",
        url: "/subtitle-scenes",
        icon: ImagesIcon,
        description:
          "Nhận dạng phụ đề rồi chụp một khung hình cho mỗi câu thoại. Xuất thư mục ảnh đánh số kèm content.json.",
      },
      {
        label: "Làm sạch metadata",
        url: "/metadata-cleaner",
        icon: ShieldCheckMarkIcon,
        description:
          "Xóa toàn bộ siêu dữ liệu (GPS, thiết bị, ngày quay, phần mềm…) khỏi video mà không giảm chất lượng.",
      },
    ],
  },
  {
    title: "Hệ thống",
    items: [{ label: "Cài đặt", url: "/settings", icon: SettingsIcon }],
  },
];

// Tool cards on the overview page: everything that has a description.
export const TOOLS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items).filter((item) => item.description);

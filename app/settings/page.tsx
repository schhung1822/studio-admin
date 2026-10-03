"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Badge, Banner, BlockStack, Button, Card, InlineStack, Layout, Link, Page, Text, TextField } from "@shopify/polaris";
import { getDesktop, isDesktop } from "../_lib/desktop";

const subscribeNever = () => () => {};

export default function SettingsPage() {
  // `false` during server render and hydration, the real value afterwards.
  const desktop = useSyncExternalStore(subscribeNever, isDesktop, () => false);
  const [groqApiKey, setGroqApiKey] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "critical"; text: string } | null>(null);

  useEffect(() => {
    const bridge = getDesktop();
    if (!bridge) return;
    let cancelled = false;
    bridge.settings
      .get()
      .then((settings) => {
        if (cancelled) return;
        setGroqApiKey(settings.groqApiKey);
        setSavedKey(settings.groqApiKey);
      })
      .catch(() => {
        if (!cancelled) setMessage({ tone: "critical", text: "Không đọc được cài đặt." });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = useCallback(async () => {
    const bridge = getDesktop();
    if (!bridge) return;
    setSaving(true);
    setMessage(null);
    try {
      const settings = await bridge.settings.set({ groqApiKey: groqApiKey.trim() });
      setSavedKey(settings.groqApiKey);
      setGroqApiKey(settings.groqApiKey);
      setMessage({ tone: "success", text: "Đã lưu. Key được dùng ngay, không cần khởi động lại." });
    } catch {
      setMessage({ tone: "critical", text: "Không lưu được cài đặt." });
    } finally {
      setSaving(false);
    }
  }, [groqApiKey]);

  const keyLooksValid = groqApiKey.trim() === "" || groqApiKey.trim().startsWith("gsk_");

  return (
    <Page fullWidth backAction={{ content: "Tổng quan", url: "/" }} title="Cài đặt">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Groq API key
                  </Text>
                  {desktop &&
                    (savedKey ? <Badge tone="success">Đã có key</Badge> : <Badge tone="attention">Chưa có key</Badge>)}
                </InlineStack>
                {desktop ? (
                  <>
                    <TextField
                      label="API key"
                      type="password"
                      value={groqApiKey}
                      onChange={setGroqApiKey}
                      autoComplete="off"
                      placeholder="gsk_…"
                      error={keyLooksValid ? undefined : "Groq API key thường bắt đầu bằng “gsk_”."}
                      helpText={
                        <>
                          Dùng cho Tách phụ đề và Phân cảnh theo phụ đề. Key chỉ được lưu trên máy này. Lấy key tại{" "}
                          <Link url="https://console.groq.com/keys" external>
                            console.groq.com/keys
                          </Link>
                          .
                        </>
                      }
                    />
                    <InlineStack align="end">
                      <Button variant="primary" onClick={handleSave} loading={saving} disabled={groqApiKey === (savedKey ?? "")}>
                        Lưu
                      </Button>
                    </InlineStack>
                  </>
                ) : (
                  <Text as="p" tone="subdued">
                    Trên bản web, key được cấu hình trên máy chủ qua biến môi trường <code>GROQ_API_KEY</code> (ví dụ
                    trong Vercel → Project Settings → Environment Variables).
                  </Text>
                )}
                {message && (
                  <Banner tone={message.tone} onDismiss={() => setMessage(null)}>
                    <p>{message.text}</p>
                  </Banner>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Phiên bản
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Text as="span">Chế độ:</Text>
                <Badge tone={desktop ? "success" : "info"}>{desktop ? "Ứng dụng Windows" : "Web"}</Badge>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                {desktop
                  ? "Xử lý video bằng FFmpeg gốc trên máy: đa luồng, đọc file trực tiếp từ ổ đĩa, không giới hạn bộ nhớ trình duyệt."
                  : "Xử lý video bằng FFmpeg.wasm ngay trong trình duyệt. Bản Windows nhanh hơn nhiều khi mã hóa lại video."}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

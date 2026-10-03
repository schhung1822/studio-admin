"use client";

import { useCallback, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AppProvider,
  Avatar,
  BlockStack,
  Box,
  Frame,
  Icon,
  InlineStack,
  Navigation,
  Text,
  TextField,
  TopBar,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import vi from "@shopify/polaris/locales/vi.json";
import { NAV_SECTIONS } from "./nav-config";
import { normalizeSearch } from "../_lib/format";

type AppLinkProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
  url: string;
  external?: boolean;
  download?: string | boolean;
};

/** Routes Polaris links (Navigation, Button url, …) through Next's client-side router. */
function AppLink({ url, external, download, children, ...rest }: AppLinkProps) {
  if (external || download || !url.startsWith("/")) {
    return (
      <a
        href={url}
        download={download}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={url} {...rest}>
      {children}
    </Link>
  );
}

function WorkspaceBadge() {
  return (
    <div style={{ display: "flex", alignItems: "center", height: "100%", paddingInline: "var(--p-space-300)" }}>
      <Link href="/" style={{ display: "inline-flex", textDecoration: "none", color: "inherit" }}>
        <Box background="bg-surface" borderRadius="200" paddingBlock="100" paddingInlineStart="100" paddingInlineEnd="300">
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Box background="bg-fill-inverse" borderRadius="150" minWidth="24px" minHeight="24px">
              <div style={{ display: "grid", placeItems: "center", width: 24, height: 24 }}>
                <Text as="span" variant="bodySm" fontWeight="bold" tone="text-inverse">
                  S
                </Text>
              </div>
            </Box>
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              Studio Edit
            </Text>
          </InlineStack>
        </Box>
      </Link>
    </div>
  );
}

function SidebarNavigation() {
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const sections = useMemo(() => {
    const needle = normalizeSearch(query.trim());
    return NAV_SECTIONS.map((section) => ({
      ...section,
      items: needle ? section.items.filter((item) => normalizeSearch(item.label).includes(needle)) : section.items,
    })).filter((section) => section.items.length > 0);
  }, [query]);

  return (
    <Navigation location={pathname} contextControl={<WorkspaceBadge />}>
      <Box paddingInline="300" paddingBlockStart="300" paddingBlockEnd="100">
        <TextField
          label="Tìm công cụ"
          labelHidden
          placeholder="Tìm công cụ…"
          value={query}
          onChange={setQuery}
          clearButton
          onClearButtonClick={() => setQuery("")}
          prefix={<Icon source={SearchIcon} tone="subdued" />}
          autoComplete="off"
          size="slim"
        />
      </Box>

      {sections.map((section, index) => (
        <Navigation.Section
          key={section.title ?? `section-${index}`}
          title={section.title}
          fill={index === sections.length - 1}
          items={section.items.map((item) => ({
            label: item.label,
            url: item.url,
            icon: item.icon,
            exactMatch: item.url === "/",
          }))}
        />
      ))}

      {sections.length === 0 && (
        <Box padding="400">
          <Text as="p" variant="bodySm" tone="subdued">
            Không tìm thấy công cụ nào.
          </Text>
        </Box>
      )}

      <Box padding="300">
        <Box background="bg-surface" borderRadius="200" borderColor="border" borderWidth="025" padding="300">
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Avatar initials="AN" name="Admin Nextgen" size="sm" />
            <BlockStack>
              <Text as="span" variant="bodySm" fontWeight="semibold">
                Admin Studio
              </Text>
              <Text as="span" variant="bodyXs" tone="subdued">
                Studio Tools
              </Text>
            </BlockStack>
          </InlineStack>
        </Box>
      </Box>
    </Navigation>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const toggleMobileNav = useCallback(() => setMobileNavOpen((open) => !open), []);

  return (
    <AppProvider i18n={vi} linkComponent={AppLink}>
      <Frame
        topBar={<TopBar showNavigationToggle onNavigationToggle={toggleMobileNav} contextControl={<WorkspaceBadge />} />}
        navigation={<SidebarNavigation />}
        showMobileNavigation={mobileNavOpen}
        onNavigationDismiss={toggleMobileNav}
      >
        <div style={{ maxWidth: 1320, margin: "0 auto" }}>{children}</div>
      </Frame>
    </AppProvider>
  );
}

"use client";

import { BlockStack, Box, Button, Card, Icon, InlineGrid, InlineStack, Page, Text } from "@shopify/polaris";
import { TOOLS } from "./_components/nav-config";

export default function OverviewPage() {
  return (
    <Page fullWidth title="Tổng quan" subtitle="Chọn một công cụ để bắt đầu. Mọi công cụ cũng có trong menu bên trái.">
      <InlineGrid columns={{ xs: 1, md: 2, lg: 3 }} gap="400">
        {TOOLS.map((tool) => (
          <Card key={tool.url}>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <Box background="bg-fill-secondary" borderRadius="200" padding="150">
                  <Icon source={tool.icon} />
                </Box>
                <Text as="h2" variant="headingMd">
                  {tool.label}
                </Text>
              </InlineStack>
              <Text as="p" tone="subdued">
                {tool.description}
              </Text>
              <InlineStack align="end">
                <Button url={tool.url}>Mở công cụ</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        ))}
      </InlineGrid>
    </Page>
  );
}

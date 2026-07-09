export const metadata = {
  title: 'Notion Updater',
  description: 'Middleware that syncs a generated chart image into a Notion page.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

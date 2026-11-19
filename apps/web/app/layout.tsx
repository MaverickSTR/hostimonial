import type { ReactNode } from "react";
import "./globals.css";
import { APP_NAME } from "@aggregator/core";
export const metadata = { title: APP_NAME };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}

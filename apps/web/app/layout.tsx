import type { ReactNode } from "react";
import { APP_NAME } from "@staywall/core";
export const metadata = { title: APP_NAME };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}

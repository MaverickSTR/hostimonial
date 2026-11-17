import { expect, test } from "vitest";
import { APP_NAME, CHANNELS } from "./index";
test("constants", () => { expect(APP_NAME).toBe("staywall"); expect(CHANNELS).toContain("airbnb"); });

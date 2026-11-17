import { expect, test } from "vitest";
import { APP_NAME, CHANNELS } from "./index";
test("constants", () => { expect(APP_NAME).toBe("aggregator"); expect(CHANNELS).toContain("airbnb"); });

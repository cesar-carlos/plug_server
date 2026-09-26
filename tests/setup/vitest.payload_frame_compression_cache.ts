import { beforeEach } from "vitest";

import { resetAdaptiveCompressionCache } from "../../src/shared/utils/payload_frame_adaptive_compression";

beforeEach(() => {
  resetAdaptiveCompressionCache();
});

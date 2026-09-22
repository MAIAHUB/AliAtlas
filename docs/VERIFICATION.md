# Verification

Checked on September 20, 2026, with Node.js 24.19.0 on Linux.

| Check                                         | Result                                            |
| --------------------------------------------- | ------------------------------------------------- |
| `npm test`                                    | 25 unit and integration tests passed              |
| `npm run build`                               | Next.js production build passed                   |
| `npm run test:e2e`                            | Both browser/API tests passed                     |
| `npm run format:check`                        | Passed                                            |
| `npm audit --omit=dev --audit-level=moderate` | No production dependency vulnerabilities reported |

Browser checks used Playwright with Chromium 153 and the production server. They uploaded actual DICOM-encoded synthetic data, verified rendered pixels, created and edited a label, checked slice-specific visibility and zoom alignment, reloaded saved annotations, exported PNG/JSON files, and checked desktop and mobile layouts. API checks exercised workspace isolation, cross-origin write protection, invalid inputs, unavailable inference, and study removal. No browser page errors were recorded.

The unit and integration suite covers signed pixels and byte order, CT rescale/windowing, Enhanced CT geometry, physical slice ordering, annotation identity, bounded ZIP extraction, LPS/RAS transformations, full NIfTI affine alignment, mask-contained anchors, and the persisted worker job lifecycle.

## Checks still needed on the target host

- Run the installed TotalSegmentator model on representative, appropriately de-identified CT series. The worker test uses a synthetic process double; it does not validate pretrained inference, model accuracy, weight downloads, or real DICOM-to-NIfTI conversion.
- Exercise compressed transfer syntaxes using the installed GDCM codecs. Native uncompressed decoding was tested here.
- Build and run the supplied Docker images, including GPU inference if used. Docker was unavailable in this environment.
- Have qualified reviewers assess model labels for each intended body region, scanner, and protocol before using them as teaching material.

No real patient data or reference screenshot was added to the repository. The preview image was captured from the passing browser test using the explicitly named synthetic QA phantom.

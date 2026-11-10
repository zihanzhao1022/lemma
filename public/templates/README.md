# Paper templates

The files a new paper copies in as attachments when it starts from a venue's template (`app/templates.ts`). Each
folder holds only what a paper needs from the venue's official kit; the preamble in `app/templates.ts` follows the
kit's example paper. Classes that TeX Live has (ACM's `acmart`, IEEE's `IEEEtran`) need no files here.

Fetched on 2026-11-10 from each venue's own source:

| Folder | Venue | Files | Source |
| --- | --- | --- | --- |
| `arxiv` | arXiv preprint (the default) | `arxiv.sty` | <https://github.com/kourgeorge/arxiv-style> |
| `acl` | ACL, EMNLP, NAACL, EACL, ARR | `acl.sty`, `acl_natbib.bst` | <https://github.com/acl-org/acl-style-files> |
| `neurips` | NeurIPS 2026 | `neurips_2026.sty` (2026-01-29) | <https://media.neurips.cc/Conferences/NeurIPS2026/Formatting_Instructions_For_NeurIPS_2026.zip> |
| `icml` | ICML 2026 | `icml2026.sty` (2025-10-29), `icml2026.bst`, `algorithm.sty`, `algorithmic.sty`, `fancyhdr.sty` | <https://media.icml.cc/Conferences/ICML2026/Styles/icml2026.zip> |
| `iclr` | ICLR 2027 | `iclr2027_conference.sty`, `iclr2027_conference.bst`, `fancyhdr.sty`, `natbib.sty`, `math_commands.tex` | <https://media.iclr.cc/Conferences/ICLR2027/iclr-2027-style-files.zip> |
| `cvpr` | CVPR 2027, ICCV, 3DV | `cvpr.sty`, `ieeenat_fullname.bst` | <https://github.com/cvpr-org/author-kit> |
| `eccv` | ECCV 2026 | `llncs.cls`, `eccv.sty`, `eccvabbrv.sty`, `splncs04.bst` (MIT licence) | <https://github.com/paolo-favaro/paper-template> |
| `aaai` | AAAI 2027 | `aaai2027.sty`, `aaai2027.bst` | <https://aaai.org/authorkit27/> |
| `ijcai` | IJCAI 2027 | `ijcai27.sty`, `named.bst` | <https://ijcai.org/sites/default/files/Guidelines/FormattingGuidelines-IJCAI-27.zip> |

The files are unchanged. Venues publish new style files every year: to move a template to a new year, replace its
files here and the names and years in `app/templates.ts`, then run `npx vitest run app/templates.test.ts`.

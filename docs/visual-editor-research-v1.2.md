# v1.2 Research: From Magazine Composer to Visual-Editor Agent

## Executive conclusion

The project already has the correct deterministic page skeleton. `InfographicSpec 1.1`, explicit story roles and priorities, three candidate desktop layouts, responsive desktop/mobile composition, a deterministic awards-informed critic, and a claim-bound explanatory-graphic pipeline cover the core responsibilities of an infographic composer and a page layout engine. Replacing them with a second composer would split the source of truth and increase the number of ways a page can bypass provenance and geometry checks.

The highest-value v1.2 architecture is therefore a closed visual editorial loop around the existing composer:

1. qualify the full Agent path against real multimodal providers, including controlled tool failure and recovery;
2. rasterize the exact page bytes and let the active multimodal provider inspect those pixels;
3. constrain model feedback to evidence-preserving layout patches;
4. add a richer illustration adapter whose output carries origin, model/tool provenance, evidence references, disclosure and content hashes;
5. make preview, visual critique and illustration provenance independently verifiable release evidence.

The deterministic semantic explainer remains useful even after richer illustration arrives. It is the safest factual diagram mode for cutaways, exploded views, anatomy and systems. Rich illustration should be an optional art-direction layer for selected modules, with publisher and competition policy deciding whether AI, human, mixed or software-rendered assets are permitted.

## What top visual-journalism competitions actually reward

### Society for News Design

SND is the closest public rubric to the target product because it evaluates whole visual-news experiences rather than isolated chart correctness. Its current competition language covers typography, styling, pacing, organization, photo editing, user experience, information architecture, usability, color, innovation, data visualization, information graphics, illustration, art direction, responsiveness, performance, compatibility, interactivity and accessibility. Its World's Best categories additionally evaluate visual storytelling, use of visual resources, news judgment, creative range, execution and voice.

The current SND rules also create an important provenance constraint. Generative-AI images or video are not accepted in the illustration, information-graphics or multimedia categories of the editorial competition. That means a newsroom Agent cannot treat one image-generation policy as universally valid. The asset contract needs an explicit origin policy, and an SND-targeted workflow must be able to require human-created illustration while still allowing AI assistance in non-reader-facing production tasks.

Engineering consequence: page quality requires a composition-level critic, responsive/accessibility gates and a policy-aware illustration origin contract. Generative illustration can be a production capability, but it must remain separable from a human-only competition path.

Sources:
- SND47 Creative Competition call for entries: https://snd.org/snd-47-best-of-news-designcall-for-entries/
- SND competition results and judging language: https://snd.org/results/
- SND47 World's Best-Designed announcement: https://snd.org/snd-2026-worlds-best-designed/

### Information is Beautiful Awards

Information is Beautiful judging guidance treats a successful visualization as a multi-objective artifact: it should be interesting, accurate and well researched, useful and easy to follow, beautiful in a way that serves the subject, and original. Their own discussion has warned that visually attractive work can be rewarded despite analytical weakness when validation is absent.

Engineering consequence: visual quality cannot override evidence integrity. The existing independent artifact verifier should remain authoritative for data, claims and content hashes. A visual critic can diagnose hierarchy and aesthetic execution, but it should never be allowed to rewrite facts or compensate for weak provenance with a high visual score.

Sources:
- Information is Beautiful Awards judging guidance: https://www.informationisbeautifulawards.com/news/236-voting-what-our-judges-and-you-look-out-for-in-great-visualization
- Information is Beautiful Awards judges: https://www.informationisbeautifulawards.com/news/598-meet-the-2023-judges

### Sigma Awards

The Sigma Awards' current rules ask for strong data collection and analysis in service of journalism, strong storytelling and engagement with visual or interactive elements, public service, and innovative ideas that move the field forward. The rules also explicitly value concise curation.

Engineering consequence: a magazine page should be evaluated as a journalistic argument. More modules do not automatically improve the result. The Agent needs to preserve a clear primary message and story arc while selecting only evidence that earns space on the page.

Source:
- Sigma Awards 2026 rules: https://www.sigmaawards.org/rules/

### Online Journalism Awards

The Online Journalism Awards' Excellence in Visual Digital Storytelling category judges the quality and impact of visuals, selection of media, effectiveness in explaining the story, and originality, innovation and creativity on digital and mobile platforms.

Engineering consequence: media choice and mobile composition are editorial decisions. The same governed story graph should be able to choose chart, diagram or illustration while preserving evidence and responsive reading order.

Source:
- Online Journalism Awards, Excellence in Visual Digital Storytelling: https://awards.journalists.org/awards/visual-digital-storytelling/

## Editorial exemplars

### South China Morning Post Graphics

SCMP publicly describes its infographics as interactive visual stories built from data, maps, video and illustration. Its print archive shows why a single-chart mental model is insufficient: award-winning pages combine annotated diagrams, maps, timelines, pictorial explanation, quantitative charts and carefully directed negative space into one editorial composition. Examples such as the Kowloon Walled City cutaway make the explanatory illustration itself the information architecture, with contextual maps and quantitative callouts orbiting a dominant visual anchor.

The transferable pattern is layered explanation. One large visual establishes a mental model; smaller charts and labels answer precise questions; typography and whitespace define reading order. The current `hero/primary/support` emphasis plus story-role system can express that structure, so the missing capability is stronger visual observation and richer assets rather than a replacement layout engine.

Sources:
- SCMP Infographics: https://www.scmp.com/infographic/
- SCMP print graphics archive: https://multimedia.scmp.com/culture/article/SCMP-printed-graphics-memory/

### Delayed Gratification

Delayed Gratification offers a complementary pattern. Art director Christian Tate describes infographics that can deliver a top-line result immediately while giving an interested reader much more to inspect. The team deliberately reuses layouts and color codes so readers build fluency across heterogeneous subjects, and it includes a "How it Works" explanation so visual grammar does not become private designer knowledge. The magazine's own discussion of its 50th issue also describes a graphic that works at two levels: a quick impression and a deeper layer for readers who want to inspect individual details.

The transferable pattern is two-speed reading. A successful page needs an immediate message, then optional detail. This argues for preserving explicit primary message, story arc, module priority and visual anchor, and for measuring hierarchy and source legibility in both desktop and mobile previews.

Sources:
- Design Week, "These 200 infographics aim to provide an answer for everything": https://www.designweek.co.uk/issues/25-31-october-2021/delayed-gratification/
- Design Week, Delayed Gratification issue 50: https://www.designweek.co.uk/issues/26-june-30-june-2023/delayed-gratification-cover-design-50th-issue/
- Bloomsbury, *An Answer for Everything*: https://www.bloomsbury.com/us/answer-for-everything-9781526633644/

## Research foundations for the critic and composer

### Graphical perception comes before ornament

Cleveland and McGill established a scientific framing for graphical perception and ranked elementary perceptual tasks by the accuracy with which people decode quantitative values. Heer and Bostock later replicated and extended graphical-perception experiments at much larger scale using crowdsourcing. These studies support an engineering rule that remains valuable even for magazine graphics: the visual system should protect accurate encodings for comparisons before it optimizes novelty or decoration.

Sources:
- Cleveland and McGill, "Graphical Perception: Theory, Experimentation, and Application to the Development of Graphical Methods," JASA 79(387), 1984, DOI 10.1080/01621459.1984.10478080: https://doi.org/10.1080/01621459.1984.10478080
- Heer and Bostock, "Crowdsourcing Graphical Perception," CHI 2010, DOI 10.1145/1753326.1753357: https://doi.org/10.1145/1753326.1753357

### Narrative visualizations need both author guidance and reader discovery

Segel and Heer analyzed narrative visualization as a design space that balances author-driven flow with reader-driven exploration. Their framework explains why a magazine infographic should not be reduced to either a dashboard or a static poster. The page needs an authored sequence, while individual visual modules can still support inspection and discovery.

Source:
- Segel and Heer, "Narrative Visualization: Telling Stories with Data," IEEE TVCG 16(6), 2010, DOI 10.1109/TVCG.2010.179: https://doi.org/10.1109/TVCG.2010.179

### Illustration and embellishment can support memory when message structure is preserved

Bateman et al. found that carefully embellished charts could preserve comprehension and improve recall in their experimental setting. Borkin et al. later studied memorability at scale, and follow-up work using eye tracking and thousands of descriptions found that titles and supporting text should communicate the message, appropriate pictograms can improve recognition, and redundant communication can reinforce the intended takeaway.

The implementation lesson is narrow. The project should permit distinctive illustration and redundant cues, but only after it protects semantic readability and the quantitative encoding. This supports a provenance-aware illustration layer whose factual labels stay bound to verified claims.

Sources:
- Bateman et al., "Useful Junk? The Effects of Visual Embellishment on Comprehension and Memorability of Charts," CHI 2010, DOI 10.1145/1753326.1753716: https://doi.org/10.1145/1753326.1753716
- Borkin et al., "What Makes a Visualization Memorable?" IEEE TVCG 19(12), 2013, DOI 10.1109/TVCG.2013.234: https://doi.org/10.1109/TVCG.2013.234
- Borkin et al., "Beyond Memorability: Visualization Recognition and Recall," IEEE TVCG 22(1), 2016, DOI 10.1109/TVCG.2015.2467732: https://doi.org/10.1109/TVCG.2015.2467732

## Why the image critic must remain a second opinion

The 2026 ICLR paper VisJudge-Bench is directly relevant because it evaluates multimodal models on visualization quality rather than natural-image aesthetics. Its benchmark contains 3,090 expert-annotated examples across 32 visualization types. The published results show a material expert-alignment gap for general multimodal models; GPT-5 is reported at roughly 0.55 MAE with about 0.43 correlation to human ratings, while the domain-specific VisJudge model improves those numbers substantially but still does not establish perfect agreement.

Engineering consequence: the visual critic should inspect real pixels and supply useful diagnostics, but release authority must remain split. Deterministic rules and the independent verifier own evidence integrity, source visibility, content hashes and structural constraints. The image-aware model owns observations about hierarchy, typography, visual coherence, composition and related appearance failures. Its machine-actionable output should be restricted to bounded layout changes such as emphasis, span, priority and ordering.

Sources:
- Xie et al., "VisJudge-Bench: Aesthetics and Quality Assessment of Visualizations," ICLR 2026: https://proceedings.iclr.cc/paper_files/paper/2026/hash/8a8b9c7f979e8819a7986b3ef825c08a-Abstract-Conference.html
- Benchmark repository: https://github.com/HKUSTDial/VisJudgeBench

## Provenance requirements for richer illustration

### Publisher policies require origin-aware behavior

Reuters states that visual journalism must present unaltered reality and prohibits generative AI from creating or enhancing imagery in its visual journalism. AP likewise prohibits generative AI from creating, altering or enhancing news photography, while allowing clearly labeled AI-generated illustrations in narrow contexts such as when the illustration itself is the subject of coverage. SND currently prohibits generative-AI imagery in editorial illustration and information-graphics categories.

The Agent therefore needs an explicit policy boundary. A rich illustration adapter must declare whether the asset is human, generative AI, mixed or software-rendered, and the caller must declare which origins are acceptable. The runtime should never infer that an AI-generated illustrative asset is permissible merely because it is technically available.

Sources:
- Reuters Journalistic Standards: https://reutersagency.com/about/standards-values/
- Associated Press standards around generative AI: https://www.ap.org/standards-around-generative-ai
- AP 2026 newsroom AI standards update: https://www.ap.org/the-definitive-source/announcements/ap-updates-newsroom-standards-for-artificial-intelligence/
- SND47 call for entries: https://snd.org/snd-47-best-of-news-designcall-for-entries/

### Metadata should preserve creation context

IPTC Photo Metadata Standard 2025.1 added AI Prompt Information, AI Prompt Writer Name, AI System Used and AI System Version Used. IPTC guidance also recommends appropriate Digital Source Type values such as trained algorithmic media or composite synthetic media for AI-generated content.

C2PA provides a stronger cryptographic provenance model: assertions are assembled into signed claims, and manifests use cryptographic content bindings so a validator can determine whether the credential belongs to the exact asset and whether bytes have changed.

The v1.2 adapter should record C2PA/IPTC-compatible metadata concepts and cryptographic content hashes, but it should not claim to issue C2PA Content Credentials unless it actually creates and signs a valid C2PA manifest with a credential. That stronger signing step remains a future integration.

Sources:
- IPTC Photo Metadata Standard 2025.1: https://www.iptc.org/std/photometadata/specification/IPTC-PhotoMetadata-2025.1.html
- IPTC AI-generated image guidance: https://www.iptc.org/std/photometadata/documentation/userguide/
- C2PA 2.4 Content Credentials specification: https://spec.c2pa.org/specifications/specifications/2.4/specs/ContentCredentials.html

## Accessibility and production hygiene

Datawrapper's production guidance is a useful baseline for chart accessibility because it treats alternative descriptions, keyboard navigation, data download and color-vision checks as built-in behavior. Magazine-grade output should carry the same mindset even when the final delivery is SVG or an image: meaningful alt text, visible source/method notes, sufficient contrast, responsive reading order and a path to the underlying data are part of editorial quality.

Source:
- Datawrapper accessibility: https://www.datawrapper.de/accessibility

The Financial Times Visual Vocabulary supplies a complementary community pattern: a chart library should serve as a set of starting points chosen by the analytical relationship, not a gallery of styles. Agentic Data Newsroom already follows this logic through a provider-independent visualization spec and should continue to invest in selection and critique rather than adding decorative chart families without a reader problem.

Source:
- Financial Times Visual Vocabulary: https://github.com/ft-interactive/visual-vocabulary

## Architecture decision

### Keep the existing Infographic Composer and page layout engine

Decision: keep and strengthen the existing composer.

Reasoning: it already exposes editorial intent, audience, primary message, story arc, module role, priority and emphasis; generates three deterministic candidates; records why a layout won; preserves semantic order for mobile; and is downstream of verified assets. A second layout engine would duplicate policy and create reconciliation problems for provenance, responsive behavior and critic state.

The useful future extension is a small repair executor that applies already validated visual-critic patches to an existing page plan and rerenders. The current Agent can perform this revision through existing planning tools, so a dedicated repair tool is an optimization rather than a v1.2 prerequisite.

### Keep deterministic explanatory illustration as the factual diagram mode

Decision: keep `newsroom_explainer_*` unchanged as the safest schematic path.

Reasoning: it produces bounded semantic structures, carries claim references and declares `SCHEMATIC / NOT TO SCALE`. It is suitable for system explanation even when a publisher forbids generated imagery. Rich illustration should supplement this path when editorial policy and provenance allow it.

### Add a provenance-aware richer illustration adapter

Decision: add a minimal stdin-JSON/stdout-JSON executable contract rather than embedding a particular image vendor SDK.

Reasoning: provider policy, cost and capabilities will change. A shell-free executable adapter keeps the newsroom core independent from image vendors and permits human-asset brokers, vector generators, local models or commercial image systems to share one validation boundary. The core owns evidence references, origin policy, sanitization, disclosure, hashes and publication gating.

### Add a real-pixel image-aware critic

Decision: rasterize the exact desktop/mobile SVGs and give those images to the same active multimodal Pi session.

Reasoning: the model must see what the reader sees. Reviewing only the page plan or SVG source cannot reliably detect clipping, optical imbalance, source-strip legibility, illustration integration or mobile hierarchy. The preview manifest must bind the PNG hashes to the exact SVG hashes so the critic cannot accidentally validate a stale render.

### Make visual feedback bounded

Decision: machine-actionable patches are limited to page layout properties such as module span, emphasis, priority and relative ordering.

Reasoning: a visual model can be helpful at diagnosing appearance while remaining unreliable at data validation. It therefore gets no authority to edit SQL, claims, source evidence, chart values or provenance. Any revised page still has to pass the deterministic critic and independent verifier before a new image-aware review can count.

## v1.2 acceptance model

A competition-grade qualification should prove one coherent sequence:

```text
real provider
  -> controlled tool failure and recovery
  -> deterministic analysis / verified claims
  -> 2+ responsive data visualizations + deterministic critics
  -> semantic explainer + deterministic critic
  -> rich illustration adapter + provenance critic
  -> existing infographic composer
  -> deterministic page critic
  -> exact desktop/mobile raster previews
  -> image-aware visual critic
  -> bounded plan repair if needed
  -> fresh render / deterministic critic / preview / image critic
  -> independent artifact verification + SQL recomputation
```

The same scenario should run against at least two real providers. Qualification records should retain wall time, tool calls, failures/recovery, plan revisions, token/cost metrics when the Pi provider exposes them, final visual-critic status and which illustration adapter was used. A bundled mock illustration adapter is sufficient to qualify the adapter contract and provenance plumbing, but it is not evidence that a real external image-generation service has been qualified.

## Explicit release boundary

v1.2 can legitimately claim a visual-editor loop, provenance-aware rich-illustration contract and provider-qualification harness once the code paths pass deterministic tests. It cannot claim real provider E2E qualification until provider credentials and the pinned Pi/Rust/DuckDB runtime execute the scenario. It cannot claim cryptographic C2PA Content Credentials until a signing implementation is added. It also cannot claim SCMP-equivalent autonomous art direction because human editorial taste, bespoke illustration and competition-specific policy still remain outside deterministic guarantees.

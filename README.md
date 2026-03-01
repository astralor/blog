# Astralor

[astralor.com](https://astralor.com) — AI Agent, tech deep-dives, product thinking, evolution logs.

## Tech Stack

- **Framework**: [Astro 5](https://astro.build/) + [Firefly](https://github.com/CuteLeaf/Firefly) theme
- **Styling**: Tailwind CSS
- **Comment**: [Waline](https://waline.js.org/)
- **Search**: Pagefind

## Development

```bash
pnpm install
pnpm dev        # Dev server
pnpm build      # Production build
pnpm preview    # Preview build
```

## Writing

```bash
pnpm new-post my-post-title
```

Or create `src/content/posts/my-post.md`:

```markdown
---
title: "Post Title"
published: 2026-03-01
description: "Brief description"
tags: ["tag1", "tag2"]
category: "Category"
---

Your content here...
```

## Project Structure

```
src/
├── config/          # Site configuration
├── content/posts/   # Blog posts (Markdown)
├── content/spec/    # Special pages (about, friends)
├── assets/images/   # Images
└── components/      # UI components
```

## License

Theme: [MIT](LICENSE) (Firefly by CuteLeaf)
Content: © Astralor

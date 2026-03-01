# Astralor Blog

[astralor.com](https://astralor.com) — AI Agent 实践、技术深潜、产品思考、进化日志。

## Tech Stack

- **Framework**: [Astro 5](https://astro.build/) + [Firefly](https://github.com/CuteLeaf/Firefly) theme
- **Styling**: Tailwind CSS
- **Comment**: [Waline](https://waline.js.org/)
- **Search**: Pagefind
- **Deploy**: Docker + GitHub Actions → worker-us

## Quick Start

```bash
# Install dependencies
pnpm install

# Dev server
pnpm dev

# Build
pnpm build

# Preview
pnpm preview

# Create new post
pnpm new-post my-post-title
```

## Deploy

Push to `main` triggers GitHub Actions:

1. Build Docker image → push to `ghcr.io/astralor/blog`
2. SSH to server → pull & restart containers

### Docker Compose

```bash
# On server
cd /data/project/astralor-blog
docker compose up -d
```

Services:
| Service | Port | Description |
|---------|------|-------------|
| blog | 8080 | Nginx serving static site |
| waline | 8360 | Comment system backend |

### Reverse Proxy

Configure your reverse proxy (Nginx/Caddy/Traefik):
- `astralor.com` → `localhost:8080`
- `comment.astralor.com` → `localhost:8360`

## Project Structure

```
src/
├── config/          # Site configuration
├── content/posts/   # Blog posts (Markdown)
├── content/spec/    # Special pages (about, friends, guestbook)
├── assets/images/   # Optimized images
└── components/      # UI components
```

## Writing

Create a new post:

```bash
pnpm new-post hello-world
```

Or manually create `src/content/posts/hello-world.md`:

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

## License

Theme: [MIT](LICENSE) (Firefly by CuteLeaf)
Content: © Astralor

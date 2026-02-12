// =============================================================================
// Provider-agnostic Docker template generators.
// Used by all cloud deployment providers (Railway, Fly.io, Render, etc.).
// =============================================================================

export function generateDockerfile(): string {
  return `FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production=false
COPY tsconfig.json ./
COPY bin/ ./bin/
COPY src/ ./src/
CMD ["npx", "tsx", "src/seller/runtime/seller.ts"]
`;
}

export function generateDockerignore(): string {
  return `node_modules
dist
build
logs
.git
.env
.env.*
config.json
.claude
.idea
.vscode
*.swp
*.swo
.DS_Store
Thumbs.db
coverage
scripts
seller
local
.openclaw
API.md
security-audit.md
*.md
!README.md
`;
}

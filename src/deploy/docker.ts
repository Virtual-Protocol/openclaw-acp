// =============================================================================
// Provider-agnostic Docker template generators.
// Used by all cloud deployment providers (Railway, Fly.io, Render, etc.).
// =============================================================================

export function generateDockerfile(): string {
  return `FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY bin/ ./bin/
COPY src/ ./src/

RUN find src/seller/offerings -mindepth 2 -maxdepth 3 -name "package.json" | \
    while IFS= read -r pkg; do \
      dir=$(dirname "$pkg"); \
      echo ">>> Installing deps in $dir"; \
      npm install --omit=dev --prefix "$dir" || exit 1; \
    done

CMD ["npm", "run", "start"]

`;
}

export function generateDockerignore(): string {
  return `node_modules
src/seller/offerings/**/node_modules
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

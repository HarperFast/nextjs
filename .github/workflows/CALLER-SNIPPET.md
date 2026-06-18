# Calling this workflow from HarperFast/harper

Add to `.github/workflows/integration-tests-nextjs.yml` in the `HarperFast/harper` repo:

```yaml
name: Next.js Integration Tests (on harper PR)

on:
  pull_request:
    paths:
      - 'src/**'
      - 'core/**'
      - 'server/**'
      - 'resources/**'
      - 'package.json'
      - 'package-lock.json'

jobs:
  nextjs-integration:
    uses: HarperFast/nextjs/.github/workflows/integration-tests.yml@main
    with:
      harper_ref: ${{ github.event.pull_request.head.sha }}
```

This causes every harper PR that touches core/server/resource code to run the full Next.js integration suite against the actual PR head. No changes to this (`HarperFast/nextjs`) repo are needed — the caller snippet is a follow-up PR to the `HarperFast/harper` repo.

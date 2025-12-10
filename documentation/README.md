# Kloqo Technical Documentation

This folder contains a multi-page HTML site covering architecture, business logic, database, APIs, frontend, backend, security, deployment, testing, troubleshooting, maintenance, and reference for the Kloqo healthcare appointment system.

## Structure
```
documentation/
├── index.html               # landing page & navigation
├── assets/
│   ├── css/documentation.css
│   └── js/navigation.js
├── pages/
│   ├── 00-overview.html
│   ├── 01-architecture.html
│   ├── 02-business-logic.html
│   ├── 03-database.html
│   ├── 04-api.html
│   ├── 05-frontend.html
│   ├── 06-backend.html
│   ├── 07-security.html
│   ├── 08-deployment.html
│   ├── 09-testing.html
│   ├── 10-troubleshooting.html
│   ├── 11-maintenance.html
│   └── 12-reference.html
```

## Viewing
Open `documentation/index.html` in a browser. Navigation links and sidebar provide quick access to all sections. A back-to-top button and print styles are included.

## Customization
- Update `assets/css/documentation.css` for theme tweaks (dark mode ready variables).
- Add diagrams/screenshots under `assets/images/diagrams/` and reference them in pages.
- Extend `navigation.js` for search or collapsible TOC refinements.

## Notes
- Content was generated from codebase analysis; review security rules and environment variables for completeness before production.
- Keep this documentation in sync with code changes, especially booking logic, Firestore schema, and env requirements.

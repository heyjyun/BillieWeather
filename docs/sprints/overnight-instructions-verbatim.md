# BillieWeather / FinRx — Overnight Autonomous Engineering Sprint
## Complete Phase 5.9 → 6.0 → 6.1 → 6.2

### 0. Autonomous execution authorization

I am going to sleep and will not be using this computer overnight.

**Desktop free. You have my permission to operate the desktop for BillieWeather QA and testing.**

You are authorized to:

- Bring the isolated BillieWeather QA application to the foreground.
- Launch, close, restart, and interact with the QA application.
- Perform native GUI testing using Accessibility and appropriate automation.
- Switch to the QA application's Space when necessary.
- Temporarily keep the computer awake during active testing.
- Build, test, debug, refactor, and rebuild the application.
- Create isolated local databases and synthetic test accounts.
- Perform local installation, migration, upgrade, and rollback rehearsals.
- Create logical local Git commits.
- Execute all safe and independently executable engineering work without further confirmation.

Do not interrupt me for ordinary engineering decisions.

Continue autonomously across all four phases. Do not stop merely because an individual phase is complete.

The objective is to complete as much of Phase 6.2 as technically possible overnight, including actual implementation and verification, not simply planning or producing reports.

---

## 1. Overnight scheduling and usage-limit recovery

All scheduling must use the local timezone **America/Chicago**.

Start immediately.

### First execution window

Continue working until:

- All objectives are completed; or
- A genuine Claude usage limit is reached; or
- A dependency requires unavailable credentials, tools, or explicit authorization.

### First usage-limit recovery: 3:00 AM

If a usage limit is encountered before 3:00 AM:

1. Persist the current execution state.
2. Preserve all completed work.
3. Record the exact next unfinished task.
4. Arrange automatic continuation at or after 3:00 AM local time.
5. Resume the same project and sprint without asking me to manually restart it.

### Second usage-limit recovery: 8:00 AM

If a usage limit is encountered again at or after 3:00 AM but before 8:00 AM:

1. Persist the updated execution state.
2. Preserve completed work.
3. Schedule another automatic continuation at or after 8:00 AM local time.
4. Resume from the latest verified checkpoint.

If the limit is still active at a scheduled restart, respect the provider's actual reset time and avoid repeated rapid retries.

Do not bypass, evade, or circumvent Claude's usage restrictions.

### Scheduling implementation

Before starting substantial engineering work, establish a real, persistent recovery mechanism.

Inspect whether an existing local Claude scheduler, CueMorrow, or supported Claude Code scheduling mechanism can reliably resume this task.

If none is suitable, implement a minimal, project-specific local scheduling mechanism using an appropriate supported macOS facility.

Requirements:

- Survives termination of the current Claude session.
- Uses the correct repository and branch.
- Restores the complete sprint instructions.
- Resumes the existing session where supported, or reconstructs context from durable checkpoints.
- Prevents duplicate concurrent executions.
- Does not modify unrelated scheduled jobs.
- Does not require new subscriptions or API spending.
- Does not store authentication tokens in scripts or logs.
- Records actual scheduled execution times.
- Stops and cleans up its own scheduled jobs once the sprint is complete.

Do not rely on an instruction written inside the current conversation alone to resume after a usage limit.

Validate that the scheduling mechanism actually exists and is functional before relying on it.

If automatic resumption cannot be established, report that honestly.

---

## 2. Persistent execution state

Create a durable sprint checkpoint under the project documentation or engineering state directory.

Suggested files:

- `docs/sprints/overnight-phase5.9-to-6.2.md`
- `docs/sprints/overnight-progress.json`
- `docs/sprints/overnight-resume-instructions.md`
- `docs/sprints/overnight-execution.log`

Maintain:

- Current phase and subphase
- Completed tasks
- Pending tasks
- Failed tasks
- External blockers
- Latest verified Git commit
- Current application artifact and checksum
- Database migration state
- Test results
- Running processes
- Next exact action
- Scheduled resume time

Update checkpoints after meaningful engineering milestones, before expensive operations, and before starting new phases.

A resumed session must read these checkpoints before making changes.

Do not repeat successfully completed work unnecessarily.

---

## 3. Phase 5.9 — Complete native macOS acceptance

Read the existing Phase 5.9 report and evidence first.

Start from:

- Final candidate source: `f4902ba`
- Latest report commit: `358e956`
- Existing branch: `autonomous-development`
- Candidate location: `ClaudeGenerated/phase5.9`

Verify the actual repository and artifact state rather than assuming that these identifiers remain unchanged.

### Mandatory acceptance

Run the actual final candidate under its intended isolated QA identity.

Complete all workflows in the Phase 5.9 acceptance matrix, including:

- Registration
- Email verification using isolated test infrastructure
- Login and logout
- Session revocation
- Sign out other devices
- Database creation
- Database selection
- Database reopening
- CSV import
- Receipt image recognition
- Scanned PDF import
- OCR review and confirmation
- Transaction editing
- Transaction classification
- Manual classification protection
- Undo and redo
- Trash and restoration
- Permanent deletion confirmation
- Feature Library
- Settings
- Language switching
- Light and dark themes
- Keyboard navigation
- Application restart
- Data persistence
- Installation and upgrade
- Vision and Tesseract fallback

You have explicit permission to use the isolated QA application's GUI overnight.

Temporarily keep the computer awake using an appropriate bounded mechanism during testing. Do not permanently change my system security or lock-screen settings.

If a GUI defect is discovered:

1. Diagnose the root cause.
2. Fix the implementation.
3. Add regression coverage.
4. Rebuild the candidate.
5. Repeat the relevant native acceptance tests.

The final tested artifact must correspond to the final verified source.

Do not transfer native acceptance results from an obsolete binary to a new binary without appropriate retesting.

---

## 4. Phase 6.0 — Repository consolidation and architecture optimization

After completing available Phase 5.9 work, continue directly to Phase 6.0.

### Repository consolidation

Audit the complete relationship between:

- `main`
- `autonomous-development`
- Existing worktrees
- Existing uncommitted modifications
- Local engineering commits
- Generated artifacts
- Temporary test directories

Investigate the previous report's statement that 115 uncommitted or untracked files in the main checkout are identical to content already present in the development branch.

Verify every relevant assumption before consolidation.

Requirements:

- Preserve all existing user work.
- Preserve all real financial records.
- Preserve relevant evidence and documentation.
- Eliminate positively identified redundant temporary artifacts.
- Avoid duplicate source implementations.
- Prepare a clean, reproducible main-branch integration.

You may perform integration and fast-forward rehearsals in isolated worktrees or repository clones.

Do not overwrite a dirty main checkout or discard existing work.

Actual main-branch merging and remote pushing remain unauthorized unless separately approved.

### Architecture optimization

Review the existing architecture comprehensively:

- Rails backend
- Python identity-api
- Universal Tauri client
- Shared TypeScript domain logic
- Rust native integration
- Local SQLite
- Neon PostgreSQL
- Authentication and session management
- OCR pipelines
- Import and classification pipelines
- Database migrations
- Feature Library
- AI Assistant
- Environment isolation

Identify and implement justified, low-risk improvements.

Prioritize:

- Clear database relationships
- Data integrity
- Single sources of truth
- Reduced duplicated business logic
- Transaction atomicity
- Consistent error handling
- Modular design
- Testability
- Maintainability
- Performance
- Secure separation of production, development, and QA

Evaluate the future migration from Rails to Python/FastAPI.

Do not perform an unnecessary full backend rewrite during this sprint.

Produce a concrete architecture decision and migration recommendation.

---

## 5. Phase 6.1 — Production infrastructure and release readiness

Continue directly after completing available Phase 6.0 work.

### Infrastructure

Complete all locally executable implementation and verification for:

- Render deployment configuration
- Neon database configuration
- Rails and identity-api integration
- Authentication migrations
- Session revocation
- Google OAuth readiness
- Email verification readiness
- Environment variable validation
- Secret management
- Production endpoint configuration
- Health checks
- Deployment dependency ordering
- Database backup and restoration
- Disaster recovery
- Monitoring and safe logging
- API compatibility

### Security

Pay particular attention to two outstanding findings:

1. Rolling back to the previous server version can make revoked tokens valid again.
2. Offline logout cannot immediately revoke copied server-side credentials.

Investigate and implement appropriate mitigations where feasible.

An authentication rollback must not silently reintroduce revoked credentials.

If an offline device cannot communicate with the server, document that fundamental limitation and evaluate reasonable session lifetime and revocation strategies.

### macOS release engineering

Prepare:

- Stable application versioning
- Reproducible release builds
- DMG packaging
- Hardened runtime
- Entitlements
- Developer ID signing configuration
- Notarization workflow
- Gatekeeper validation
- Installation documentation
- Upgrade documentation
- Rollback procedures

Do not fabricate signing identities, credentials, or successful notarization.

If external credentials are unavailable, complete all preparation and mark the remaining action BLOCKED.

### Production safety

Do not:

- Write to Neon production.
- Modify existing production databases.
- Deploy to Render production.
- Create paid cloud resources.
- Purchase developer memberships.
- Access unrelated accounts.
- Expose or copy secrets.

Use isolated local infrastructure for rehearsals.

---

## 6. Phase 6.2 — Cross-platform release readiness

Continue automatically after completing available Phase 6.1 tasks.

The objective is to make every supported platform as release-ready as the available environment permits.

### Web

Verify:

- Responsive desktop and mobile layouts
- Authentication
- Registration
- Financial workflows
- Feature Library
- Settings
- Localization
- Accessibility
- Browser compatibility
- Production build
- Deployment configuration

### macOS Apple Silicon

Complete:

- Native GUI acceptance
- Installation and upgrade
- Local data persistence
- OCR functionality
- Authentication
- Release packaging
- Performance
- Crash recovery

### macOS Intel

Inspect compatibility and build configuration.

Build and test where the available toolchain permits.

Do not treat Apple Silicon acceptance as Intel acceptance.

### Windows

Inspect and improve:

- Native build configuration
- SQLite storage paths
- Installer configuration
- Windows-specific permissions
- File selection
- OCR integration
- Update mechanism
- Authentication
- Cross-platform UI consistency

Build Windows artifacts only using an appropriate available toolchain.

### iOS

Inspect and improve:

- Existing mobile architecture
- iPhone and iPad layouts
- Local storage
- Authentication
- File and camera imports
- OCR support
- Touch interactions
- Permissions
- Mobile lifecycle handling
- Build configuration

Build and run simulator tests if an appropriate Xcode environment is available.

### Android

Inspect and improve:

- Android build configuration
- Mobile layouts
- Local database storage
- File and camera imports
- OCR support
- Authentication
- Permissions
- Mobile lifecycle handling
- Packaging

Build and run emulator tests if appropriate tooling is available.

### Platform requirements

Do not claim a platform is ready for release merely because its shared code passes tests.

For every platform, distinguish:

- Code implemented
- Build verified
- Automated tests passed
- Native GUI verified
- Real-device verified
- Distribution ready

Missing platform toolchains are blockers, not reasons to stop all other engineering work.

Do not initiate enormous toolchain downloads or installations without approval. Inspect existing availability and complete all independent work first.

---

## 7. Product scope constraints

Preserve BillieWeather's established product direction.

- Local-first financial privacy
- Reliable financial record management
- Automated statement import
- Receipt and PDF recognition
- Intelligent transaction classification
- User-controlled financial databases
- AI financial assistance
- Modular Feature Library
- Transactions and AI Assistant enabled by default
- Settings always accessible

Do not reintroduce previously removed features:

- Real payments or transfers
- Foreign exchange execution
- International remittance
- Card issuance
- Credit scoring or monitoring
- Financial product recommendations
- Investment performance modules previously excluded from scope

Do not introduce unrelated functionality.

---

## 8. Autonomous defect resolution

Throughout the sprint, actively detect and fix:

- Broken workflows
- Authentication failures
- Incorrect database behavior
- Data loss risks
- UI/UX defects
- Misleading error messages
- Crashes
- Application freezes
- OCR failures
- Platform inconsistencies
- Security vulnerabilities
- Build failures
- Flaky tests
- Dependency issues
- Architectural inconsistencies

For each material defect:

Root cause → Implementation → Regression test → Verification → Local commit.

Do not merely document defects that can safely be fixed.

Do not repeatedly retry identical failed approaches without investigating their root causes.

---

## 9. Strict safety and isolation

Previous phases contained several operational mistakes. Do not repeat them.

Specifically:

- Never interact with unrelated application windows.
- Verify the target process, Bundle ID, window identity, and QA data directory before GUI actions.
- Capture only the QA application window, not the entire desktop.
- Never inspect unrelated personal files or applications.
- Never access real financial database directories for testing.
- Never accidentally run tests against the default or production database.
- Validate database isolation before every test suite.
- Never execute cleanup commands using unset or unvalidated path variables.
- Verify absolute paths before deleting generated artifacts.
- Do not use broad recursive deletion against ambiguous directories.
- Preserve existing installed applications and real user data.
- Do not disable system security protections.
- Do not push, merge into the actual main branch, or deploy without authorization.
- Do not incur external costs.

Ordinary safe local engineering work is fully authorized.

When blocked by an external requirement, record the blocker and continue with other independent work.

---

## 10. Final comprehensive regression

Before completing the sprint, run all applicable suites:

- Universal client
- TypeScript
- Rust
- Rails
- Identity API
- Database migrations
- SQLite integrity
- Authentication security
- OCR reliability
- Native macOS GUI
- Web browser workflows
- Cross-platform builds and tests

Record actual results, including failures, skips, and blockers.

Build the final locally verified candidate.

Record:

- Git commit
- Application version
- Executable checksum
- Package checksum
- Build environment
- Database schema versions
- Platform support matrix

---

## 11. Final morning report

Create one consolidated report covering the complete overnight sprint.

Suggested location:

`docs/audits/overnight-phase5.9-to-6.2-final-report.md`

Include:

1. Executive summary
2. Phase 5.9 final status
3. Phase 6.0 final status
4. Phase 6.1 final status
5. Phase 6.2 final status
6. Native GUI acceptance matrix
7. Bugs discovered and fixed
8. Architecture improvements
9. Database improvements
10. Security improvements
11. Complete test results
12. Platform-specific readiness
13. Local commits
14. Final application artifact locations
15. Outstanding external requirements
16. Usage-limit interruptions and actual resume times
17. Any operational mistakes or deviations
18. Remaining user decisions
19. Exact next steps

Use explicit statuses:

- PASS
- FAIL
- BLOCKED
- NOT TESTED
- CONDITIONAL GO
- GO
- NO-GO

Do not declare Phase 6.2 complete if mandatory platform requirements remain unverified.

Clearly distinguish engineering completion from production release readiness.

---

## 12. Final execution instruction

I am going to sleep.

You have uninterrupted desktop access for authorized BillieWeather QA work.

Start immediately.

Do not wait for further instructions between phases.

Do not stop after Phase 5.9, 6.0, or 6.1.

Continue toward Phase 6.2.

If usage limits interrupt execution, automatically resume at or after 3:00 AM Chicago time. If another usage limit interrupts execution after 3:00 AM, automatically resume again at or after 8:00 AM.

Preserve progress continuously.

Complete every safe, technically executable task before stopping.

When I return, I want to see the maximum achievable progress, a genuinely tested application, a clean engineering state, and a comprehensive evidence-based report—not another intermediate planning document.

**Begin the overnight autonomous sprint now.**

OpenKey weekly reservation

New command:
  node openkey-reserve.js --days-from-now 7 --time 18:30 --yes

The workflow runs weekly on Thursday at 00:00 Argentina time.
It makes ONE attempt only. No retry loop is included.

GitHub Actions scheduling is minute-granularity and can start late. The workflow
waits until 00:00:01 only when the runner is already running before that instant.
If GitHub launches the job later, it executes the one attempt immediately.

Required GitHub repository secrets:
  OPENKEY_DOCUMENT
  OPENKEY_PASSWORD

Place reserve-padel.yml at:
  .github/workflows/reserve-padel.yml

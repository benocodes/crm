// An actual authorized runner must be designed for an existing disposable binding.
// No cloud resource creation, deployment, REST transaction emulation, or token handling.
if (process.env.CORE33_REMOTE_RUNNER) {
  throw new Error(
    'runner not integrated: supply existing authorized binding/invocation contract before remote execution',
  )
}
console.log('not run — no authorised remote binding runner')

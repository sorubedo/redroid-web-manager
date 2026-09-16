import { Effect } from "effect"

const program = Effect.sync(() => {
  console.log("Hello, world!")
})

Effect.runSync(program)

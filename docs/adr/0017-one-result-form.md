# Every tool result reaches the Agent as one compact JSON form

Each tool result had two forms: structured content, and a text written for the Agent beside it. Claude Code shows the Agent only the structured content, so whatever the text alone said (glosses, what was not checked, what to tell the User) never reached it there; and no client shows an Agent the output schema, so guidance in its field descriptions reached none. Every successful result's text is now exactly the compact JSON of its structured content, built in one place, so every client shows the same facts and a new field is written once. A result leaves out null and empty fields, except what its outputSchema declares as data: any value stays whole, and a set of request fields stays whole unless empty. The schema is the one place that says so, for the result, the tests and the types alike. Errors stay plain text. Guidance lives in the server instructions and tool descriptions, which every Agent reads.

## Considered Options

- **Keep the text and copy everything into structured content**: rejected because each fact would still be kept twice, in two forms that drift apart.
- **Text only, no output schema**: rejected because the MCP spec asks for structured content that matches a declared schema, and clients that read it would lose the types.

# What is learnt about a Model goes into its Model Notes, and only with the User's agreement

Ratings and Picks accumulate in the Job history, and the Agent should choose better because of them. litevision runs no model of its own to summarise them, so the Agent does: `list_models` with `model` shows that Model's recent Ratings and the Picks of Comparisons it took part in, and when one says something the Model Notes do not, the Agent proposes new Model Notes and writes them only once the User agrees, as for any other change to them. The Model Notes stay the one place where what the Agent knows about a Model is something the User has agreed to.

## Considered Options

- **A second, Agent-written field beside the Model Notes**: rejected because it would put text the User never reviewed in front of every Agent, free to contradict the Model Notes.
- **litevision summarises the Job history itself**: rejected because it would need a model, a Credential and a cost of its own, when the User's Agent is already there.
- **Rating counts for every Model in every `list_models`**: rejected because each listing would grow with the history, while the Model Notes are already the summary.

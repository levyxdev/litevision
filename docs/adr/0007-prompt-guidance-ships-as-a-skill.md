# Prompt guidance ships as a Skill; the server instructions keep only the rules

v1 shipped no Skill and put all guidance in the MCP server instructions. How to get good results (writing prompts in English while text to appear in the result keeps its own language, describing a scene in sentences, checking a result against the request before reporting it, writing the variants of a Comparison, when to propose one or new Model Notes) is long, mostly the same for every Model, and needed only while generating. The server instructions are loaded into every conversation, so they keep only the rules an Agent must not break (Credentials, Ratings and Picks only on the User's word, the User's agreement before a Comparison or a Model Notes change, retry limits) and point to the Skill. The Skill lives in this repository at `skills/litevision/`, is installed with `npx skills add`, and changes only with a litevision release; the Agent never edits it. What is learnt about one Model goes into its Model Notes instead (ADR 0008).

## Considered Options

- **Everything in the server instructions**: rejected because every conversation would pay for guidance most of them never use.
- **Prompting tips in each Model's Notes**: rejected because the tips are nearly all the same for every Model, and 300 characters cannot hold them.

## Consequences

An Agent without Skill support gets the rules but not the tips. Model Notes record only what is particular to a Model, including where it departs from the Skill.

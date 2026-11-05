---
name: litevision
description: Writing prompts for litevision's generate_image, generate_video and generate_comparison, checking each result, and when to propose a Comparison or new Model Notes.
---

# litevision

Drawn from the Model makers' own prompting guides (Sources, below).

## Write the prompt

- **English**, whatever language the User writes in: every Model handles it, and some handle only a few other languages well [Google]. Text that must appear in the result stays in its own language and script, exactly as it must read, in double quotes, with where it goes and how it looks: `A red banner across the top reads "新年快乐" in bold brush calligraphy.` Ask for that text and no other; spell unusual words letter by letter [OpenAI, Google, FLUX].
- **Describe the scene in sentences**, most important first: the subject, the setting, the composition (framing, camera angle), the lighting, the style or medium. Sentences carry relationships a keyword list loses: who holds what, what stands behind what, where the light comes from [Google, FLUX, Seedream, OpenAI].
- **Exact counts and positions**: "three lemons in a row on the left half, a knife lying diagonally at the bottom right", rather than "some lemons".
- **Say what should be there**: "an empty, deserted street" rather than "no cars". FLUX has no negative prompt at all [Google, FLUX].
- **With reference images**, name each by position ("image 1", "image 2") and say what it is for. Say what changes, then list what must stay unchanged (identity, pose, layout, lighting, text): "Change only the jacket to red leather; keep the face, pose, background and lighting of image 1 exactly as they are" [OpenAI, Google, FLUX].

## Ask for one image

Leave `n` at 1 unless the User wants several to choose from. Images from one Job differ only by chance; to explore different readings of a request, propose a Comparison instead.

## Check every result

Before reporting a result, open each file and check it against the request: subject, counts, positions, each quoted text letter by letter, what had to stay unchanged. Tell the User plainly what is wrong, then let them decide what comes next: generate again when they ask, and leave the verdict to them.

## Propose a Comparison

Propose one when the request is ambiguous (two readings that would look clearly different: "a logo for Sol", sun or Spanish?) or when no Model clearly fits it, judging by the capabilities, Model Notes and Ratings `list_models` shows. Say what each variant tries.

Write the variants so the User's Pick says something:

- For an ambiguous request: one variant per reading, on the same Model, each prompt a full description of that reading.
- To compare Models: the same prompt on each Model.
- Between variants, change only that one thing.

## Propose new Model Notes

Propose new Model Notes when a Rating or Pick shows something the Model's Notes do not say ("misspells Chinese text", "picked over the others for photoreal scenes"), or when the User asks. At most once per Model per conversation. Write only what is particular to that Model, including where it departs from this Skill ("follows Chinese prompts better than English"); leave out what holds for every Model: this Skill covers it.

## Sources

- [OpenAI] Image prompting: https://developers.openai.com/api/docs/guides/image-prompting
- [Google] Nano Banana image generation, "Prompting guide and strategies": https://ai.google.dev/gemini-api/docs/image-generation
- [FLUX] Black Forest Labs, Prompting Basics and Technical Parameters: https://docs.bfl.ai/guides/prompting_unified_basics, https://docs.bfl.ai/guides/prompting_unified_technical; Together AI, FLUX quickstart, "Prompting best practices": https://docs.together.ai/docs/quickstart-flux
- [Seedream] ByteDance, Seedream 4.0-4.5 prompt guide: https://docs.byteplus.com/en/docs/modelark/seedream-4-0-5-0-prompt-guide

Other makers' Models follow the same advice; their Model Notes record where one departs from it.

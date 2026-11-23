---
name: litevision
description: Writing prompts for litevision's generate_image, generate_video and generate_comparison, when to look at a result, when to propose a Comparison or new Model Notes, and setting up a local Model on the User's machine.
---

# litevision

Drawn from the Model makers' own prompting guides (Sources, below).

## Write the prompt

- **English**, whatever language the User writes in: every Model handles it, and some handle only a few other languages well. Text that must appear in the result stays in its own language and script, exactly as it must read, in double quotes, with where it goes and how it looks: `A red banner across the top reads "新年快乐" in bold brush calligraphy.` Ask for that text and no other; spell unusual words letter by letter.
- **Describe the scene in sentences**, most important first: the subject, the setting, the composition (framing, camera angle), the lighting, the style or medium. Sentences carry relationships a keyword list loses: who holds what, what stands behind what, where the light comes from.
- **Exact counts and positions**: "three lemons in a row on the left half, a knife lying diagonally at the bottom right", rather than "some lemons".
- **Say what should be there**: "an empty, deserted street" rather than "no cars". FLUX has no negative prompt at all.
- **With reference images**, name each by position ("image 1", "image 2") and say what it is for: litevision sends `references` in the order given and has no field for an image's role, so the prompt carries it. "Image 1 is the person; image 2 is only a layout guide, take nothing else from it." Say what changes, then list what must stay unchanged (identity, pose, layout, lighting, text): "Change only the jacket to red leather; keep the face, pose, background and lighting of image 1 exactly as they are".

## Set the size, resolution and length

Each Model names them its own way: `{ "size": "2048x1152" }` for GPT Image, `{ "response_format": { "aspect_ratio": "16:9", "image_size": "2K" } }` for Gemini, `{ "resolution": "1080P", "ratio": "9:16", "seconds": "10" }` for Wan 2.7. Leave them out and the Provider's defaults apply. Weigh the Parameter Guide's prices: on some Models a larger size costs no more.

## Ask for one image

Leave `n` at 1 unless the User wants several to choose from. Images from one Job differ only by chance; to explore different readings of a request, propose a Comparison instead.

## Name the files

Pass `name` when the request says what a result is for or who it shows, in the User's own words and language: `name: "张三"` for Zhang San's ID photo saves `张三.png`. litevision adds `-1`, `-2` for several results and the next free number when the name is taken. Without it, files are named after the time the Job started. In a Comparison, give each variant its own `name` when the variants are for different things.

## When to look at a result

Describe only what you have seen. Look at a result when the User asks (for one result, or for every result until they say stop), or when your next step depends on what it shows, such as editing it as a Reference or generating until the text reads right. Then compare it with the request: subject, counts, positions, each quoted text letter by letter, what had to stay unchanged. Tell the User plainly what is wrong, then let them decide what comes next: generate again when they ask, and leave the verdict to them.

## Propose a Comparison

Propose one when the request is ambiguous (two readings that would look clearly different: "a logo for Sol", sun or Spanish?) or when no Model clearly fits it, judging by the Parameter Guides, Model Notes and Ratings `list_models` shows. Say what each variant tries.

Write the variants so the User's Pick says something:

- For an ambiguous request: one variant per reading, on the same Model, each prompt a full description of that reading.
- To compare Models: the same prompt on each Model, and in each variant's own `provider_options` the same shape in that Model's own fields.
- Between variants, change only that one thing.

## Set up a local Model

When the User wants images made on their own machine, with no Provider, read [LOCAL.md](LOCAL.md).

## Propose new Model Notes

Propose new Model Notes when a Rating or Pick shows something the Model's Notes do not say ("misspells Chinese text", "picked over the others for photoreal scenes", "quality=low looks blurry"), or when the User asks. A Rating never changes an Option Status, so the Model Notes are where the effect of an option no check can measure gets written down. At most once per Model per conversation. Write only what is particular to that Model, including where it departs from this Skill ("follows Chinese prompts better than English"); leave out what holds for every Model: this Skill covers it.

## Sources

- OpenAI, Image prompting: https://developers.openai.com/api/docs/guides/image-prompting
- Google, Nano Banana image generation, "Prompting guide and strategies": https://ai.google.dev/gemini-api/docs/image-generation
- Black Forest Labs, Prompting Basics and Technical Parameters: https://docs.bfl.ai/guides/prompting_unified_basics, https://docs.bfl.ai/guides/prompting_unified_technical; Together AI, FLUX quickstart, "Prompting best practices": https://docs.together.ai/docs/quickstart-flux
- ByteDance, Seedream 4.0-4.5 prompt guide: https://docs.byteplus.com/en/docs/modelark/seedream-4-0-5-0-prompt-guide

Other makers' Models follow the same advice; their Model Notes record where one departs from it.

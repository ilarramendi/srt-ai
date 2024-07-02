import process from 'node:process';
import fs from 'node:fs';
import {glob} from 'glob';
import { encoding_for_model } from "tiktoken";
import dotenv from 'dotenv';
dotenv.config();

const {OPENAI_API_KEY, TARGET_LANGUAGE, LANGUAGE_SHORT, EXTRA_SPECIFICATION, MAX_TOKENS, AI_MODEL} = process.env;

if (!OPENAI_API_KEY) {
	console.error('OPENAI_API_KEY is not set');
	process.exit(1);
}

const paths = glob.sync(process.argv[2]).filter(path => path.endsWith('.srt'));

for (const path of paths) {
	await translatePath(path);
}

if (paths.length === 0) {
	console.error('No files found for pattern', process.argv[2]);
}

function groupSegmentsByTokenLength(segments, length) {
	const groups = [];
	let currentGroup = [];
	let currentGroupTokenCount = 0;
	const encoder = encoding_for_model(AI_MODEL);

	function numTokens(text) {
		const tokens = encoder.encode(text);
		return tokens.length;
	}

	for (const segment of segments) {
		const segmentTokenCount = numTokens(segment.content);

		if (currentGroupTokenCount + segmentTokenCount <= length) {
			currentGroup.push(segment);
			currentGroupTokenCount += segmentTokenCount + 1; // include size of the "|" delimeter
		} else {
			groups.push(currentGroup);
			currentGroup = [segment];
			currentGroupTokenCount = segmentTokenCount;
		}
	}

	if (currentGroup.length > 0) {
		groups.push(currentGroup);
	}

	encoder.free(); // clear encoder from memory
	return groups;
}

async function translate(text) {
	const response = await fetch("https://api.openai.com/v1/chat/completions", {
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${OPENAI_API_KEY}`,
		},
		method: "POST",
		body: JSON.stringify({
			model: AI_MODEL,
			frequency_penalty: 0,
			presence_penalty: 0,
			top_p: 1,
			temperature: 0,
			messages: [
				{
					role: "system",
					content:
						"You are an experienced semantic translator. Follow the instructions carefully.",
				},
				{
					role: "user",
					content: `Translate this to ${TARGET_LANGUAGE}${EXTRA_SPECIFICATION ? ` , and ${EXTRA_SPECIFICATION}` : ''}. Use the '|' segment separator in the response. ALWAYS return the SAME number of segments. NEVER skip any segment. NEVER combine segments. Ensure the number of segments matches the original text.\n\n${text}`,
				},
			]
		}),
	});
	if (response.status !== 200) {
		throw new Error('Failed to translate: ' + await response.text());
	}
	const data = await response.json();
	const choice = data.choices[0];
	if (choice.finish_reason !== 'stop') {
		throw new Error('Failed to translate, translation stopped: ' + choice.finish_reason);
	}

	const originalSplit = text.split('|');
	const split = choice.message.content.split('|').map(s => s.trim());
	if (split.at(-1) === '') {
		split.pop();
	}
	const max = Math.max(split.length, originalSplit.length);
	if (process.argv.includes('--debug')) {
		for (let i = 0; i < max; i++) {
			if (split[i] !== originalSplit[i]) {
				console.log(originalSplit[i] || '')
				console.log(split[i] || '')
				console.log('---')
			}
		}

		if (split.length !== originalSplit.length) {
			if (!process.argv.includes('--debug')) {
				for (let i = 0; i < max; i++) {
					if (split[i] !== originalSplit[i]) {
						console.log(originalSplit[i] || '')
						console.log(split[i] || '')
						console.log('---')
					}
				}
			}
			throw new Error('Failed to translate, translation length mismatch, received ' + split.length + ' segments, expected ' + text.split('|').length);
		}

		return split;
	}
}

async function translatePath(path) {
	let [_, ...ext] = path.split('/').pop().split('.');
	ext = ext.join('.');
	const existingFiles = glob.sync(path.replace(ext, '*.srt'));
	for (const existingFile of existingFiles) {
		if (existingFile.endsWith(`.${TARGET_LANGUAGE} (AI).srt`)) {
			console.warn('Skipping, already translated:', path);
			return;
		}
		if (!process.argv.includes('--ignore-existing-translation')) {
			if (existingFile.endsWith(`.${LANGUAGE_SHORT}.srt`) || existingFile.endsWith(`.${TARGET_LANGUAGE}.srt`)) {
				console.warn('Skipping, existing translation:', path);
				return;
			}
		}

	}
	console.log('Started translation of', path);
	const content = fs.readFileSync(path).toString();
	const matches = [];
	for (const match of content.matchAll(/(\d+\r?\n.* --> .*\r?\n)((?:.+\r?\n)+)/g)) {
		matches.push({
			header: match[1],
			content: match[2].slice(0, -1).replace(/\n/g, ' '),
		});
	}
	if (matches.length === 0) {
		console.log(JSON)
		console.warn('No matches found in', path);
		return;
	}
	const groups = groupSegmentsByTokenLength(matches, MAX_TOKENS);
	for (const group of groups) {
		const translated = await translate(group.map(m => m.content).join('|'));
		for (const [i, translatedMatch] of translated.entries()) {
			group[i].translatedContent = translatedMatch;
		}
	}
	fs.writeFileSync(
		path.replace(/(?:\.en(?:-[a-z]+)?)?\.srt$/, `.${TARGET_LANGUAGE} (AI).srt`),
		matches.map(m => m.header + m.translatedContent).join('\n\n')
	);
	console.log('Successfully translated');
}


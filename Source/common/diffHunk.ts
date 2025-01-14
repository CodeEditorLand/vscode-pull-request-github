/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Inspired by and includes code from GitHub/VisualStudio project, obtained from  https://github.com/github/VisualStudio/blob/master/src/GitHub.Exports/Models/DiffLine.cs
 */

import { IRawFileChange } from "../github/interface";
import { GitChangeType, InMemFileChange, SlimFileChange } from "./file";

export enum DiffChangeType {
	Context,
	Add,
	Delete,
	Control,
}

export class DiffLine {
	public get raw(): string {
		return this._raw;
	}

	public get text(): string {
		return this._raw.substr(1);
	}

	constructor(
		public type: DiffChangeType,
		public oldLineNumber: number /* 1 based */,
		public newLineNumber: number /* 1 based */,
		public positionInHunk: number,
		private _raw: string,
		public endwithLineBreak: boolean = true,
	) {}
}

export function getDiffChangeType(text: string) {
	const c = text[0];

	switch (c) {
		case " ":
			return DiffChangeType.Context;

		case "+":
			return DiffChangeType.Add;

		case "-":
			return DiffChangeType.Delete;

		default:
			return DiffChangeType.Control;
	}
}

export class DiffHunk {
	public diffLines: DiffLine[] = [];

	constructor(
		public oldLineNumber: number,
		public oldLength: number,
		public newLineNumber: number,
		public newLength: number,
		public positionInHunk: number,
	) {}
}

export const DIFF_HUNK_HEADER = /^@@ \-(\d+)(,(\d+))?( \+(\d+)(,(\d+)?)?)? @@/;

export function countCarriageReturns(text: string): number {
	let count = 0;

	let index = 0;

	while ((index = text.indexOf("\r", index)) !== -1) {
		index++;

		count++;
	}

	return count;
}

export function* LineReader(text: string): IterableIterator<string> {
	let index = 0;

	while (index !== -1 && index < text.length) {
		const startIndex = index;

		index = text.indexOf("\n", index);

		const endIndex = index !== -1 ? index : text.length;

		let length = endIndex - startIndex;

		if (index !== -1) {
			if (index > 0 && text[index - 1] === "\r") {
				length--;
			}

			index++;
		}

		yield text.substr(startIndex, length);
	}
}

export function* parseDiffHunk(
	diffHunkPatch: string,
): IterableIterator<DiffHunk> {
	const lineReader: Iterator<string, string> = LineReader(diffHunkPatch);

	let itr = lineReader.next();

	let diffHunk: DiffHunk | undefined = undefined;

	let positionInHunk = -1;

	let oldLine = -1;

	let newLine = -1;

	while (!itr.done) {
		const line = itr.value;

		if (DIFF_HUNK_HEADER.test(line)) {
			if (diffHunk) {
				yield diffHunk;

				diffHunk = undefined;
			}

			if (positionInHunk === -1) {
				positionInHunk = 0;
			}

			const matches = DIFF_HUNK_HEADER.exec(line);

			const oriStartLine = (oldLine = Number(matches![1]));
			// http://www.gnu.org/software/diffutils/manual/diffutils.html#Detailed-Unified
			// `count` is added when the changes have more than 1 line.
			const oriLen = Number(matches![3]) || 1;

			const newStartLine = (newLine = Number(matches![5]));

			const newLen = Number(matches![7]) || 1;

			diffHunk = new DiffHunk(
				oriStartLine,
				oriLen,
				newStartLine,
				newLen,
				positionInHunk,
			);
			// @rebornix todo, once we have enough tests, this should be removed.
			diffHunk.diffLines.push(
				new DiffLine(
					DiffChangeType.Control,
					-1,
					-1,
					positionInHunk,
					line,
				),
			);
		} else if (diffHunk) {
			const type = getDiffChangeType(line);

			if (type === DiffChangeType.Control) {
				if (diffHunk.diffLines && diffHunk.diffLines.length) {
					diffHunk.diffLines[
						diffHunk.diffLines.length - 1
					].endwithLineBreak = false;
				}
			} else {
				diffHunk.diffLines.push(
					new DiffLine(
						type,
						type !== DiffChangeType.Add ? oldLine : -1,
						type !== DiffChangeType.Delete ? newLine : -1,
						positionInHunk,
						line,
					),
				);

				const lineCount = 1 + countCarriageReturns(line);

				switch (type) {
					case DiffChangeType.Context:
						oldLine += lineCount;

						newLine += lineCount;

						break;

					case DiffChangeType.Delete:
						oldLine += lineCount;

						break;

					case DiffChangeType.Add:
						newLine += lineCount;

						break;
				}
			}
		}

		if (positionInHunk !== -1) {
			++positionInHunk;
		}

		itr = lineReader.next();
	}

	if (diffHunk) {
		yield diffHunk;
	}
}

export function parsePatch(patch: string): DiffHunk[] {
	const diffHunkReader = parseDiffHunk(patch);

	let diffHunkIter = diffHunkReader.next();

	const diffHunks: DiffHunk[] = [];

	while (!diffHunkIter.done) {
		const diffHunk = diffHunkIter.value;

		diffHunks.push(diffHunk);

		diffHunkIter = diffHunkReader.next();
	}

	return diffHunks;
}

/**
 * Split a hunk into smaller hunks based on the context lines. Position in hunk and control lines are not preserved.
 */
export function splitIntoSmallerHunks(hunk: DiffHunk): DiffHunk[] {
	const splitHunks: DiffHunk[] = [];

	const newHunk = (fromLine: DiffLine) => {
		return {
			diffLines: [],
			newLength: 0,
			oldLength: 0,
			oldLineNumber: fromLine.oldLineNumber,
			newLineNumber: fromLine.newLineNumber,
			positionInHunk: 0,
		};
	};

	// Split hunk into smaller hunks on context lines.
	// Context lines will be duplicated across the new smaller hunks
	let currentHunk: DiffHunk | undefined;

	let nextHunk: DiffHunk | undefined;

	const addLineToHunk = (hunk: DiffHunk, line: DiffLine) => {
		hunk.diffLines.push(line);

		if (line.type === DiffChangeType.Delete) {
			hunk.oldLength++;
		} else if (line.type === DiffChangeType.Add) {
			hunk.newLength++;
		} else if (line.type === DiffChangeType.Context) {
			hunk.oldLength++;

			hunk.newLength++;
		}
	};

	const hunkHasChanges = (hunk: DiffHunk) => {
		return hunk.diffLines.some(
			(line) => line.type !== DiffChangeType.Context,
		);
	};

	const hunkHasSandwichedChanges = (hunk: DiffHunk) => {
		return (
			hunkHasChanges(hunk) &&
			hunk.diffLines[hunk.diffLines.length - 1].type ===
				DiffChangeType.Context
		);
	};

	for (const line of hunk.diffLines) {
		if (line.type === DiffChangeType.Context) {
			if (!currentHunk) {
				currentHunk = newHunk(line);
			}

			addLineToHunk(currentHunk, line);

			if (hunkHasSandwichedChanges(currentHunk)) {
				if (!nextHunk) {
					nextHunk = newHunk(line);
				}

				addLineToHunk(nextHunk, line);
			}
		} else if (currentHunk) {
			if (hunkHasSandwichedChanges(currentHunk)) {
				splitHunks.push(currentHunk);

				currentHunk = nextHunk!;

				nextHunk = undefined;
			}

			if (
				line.type === DiffChangeType.Delete ||
				line.type === DiffChangeType.Add
			) {
				addLineToHunk(currentHunk, line);
			}
		}
	}

	if (currentHunk) {
		splitHunks.push(currentHunk);
	}

	return splitHunks;
}

export function getModifiedContentFromDiffHunk(
	originalContent: string,
	patch: string,
) {
	const left = originalContent.split(/\r?\n/);

	const diffHunkReader = parseDiffHunk(patch);

	let diffHunkIter = diffHunkReader.next();

	const diffHunks: DiffHunk[] = [];

	const right: string[] = [];

	let lastCommonLine = 0;

	let lastDiffLineEndsWithNewline = true;

	while (!diffHunkIter.done) {
		const diffHunk: DiffHunk = diffHunkIter.value;

		diffHunks.push(diffHunk);

		const oriStartLine = diffHunk.oldLineNumber;

		for (let j = lastCommonLine + 1; j < oriStartLine; j++) {
			right.push(left[j - 1]);
		}

		lastCommonLine = oriStartLine + diffHunk.oldLength - 1;

		for (let j = 0; j < diffHunk.diffLines.length; j++) {
			const diffLine = diffHunk.diffLines[j];

			if (
				diffLine.type === DiffChangeType.Delete ||
				diffLine.type === DiffChangeType.Control
			) {
			} else if (diffLine.type === DiffChangeType.Add) {
				right.push(diffLine.text);
			} else {
				const codeInFirstLine = diffLine.text;

				right.push(codeInFirstLine);
			}
		}

		diffHunkIter = diffHunkReader.next();

		if (diffHunkIter.done) {
			// Find last line that wasn't a delete
			for (let k = diffHunk.diffLines.length - 1; k >= 0; k--) {
				if (diffHunk.diffLines[k].type !== DiffChangeType.Delete) {
					lastDiffLineEndsWithNewline =
						diffHunk.diffLines[k].endwithLineBreak;

					break;
				}
			}
		}
	}

	if (lastDiffLineEndsWithNewline) {
		// if this is false, then the patch has shortened the file
		if (lastCommonLine < left.length) {
			for (let j = lastCommonLine + 1; j <= left.length; j++) {
				right.push(left[j - 1]);
			}
		} else {
			right.push("");
		}
	}

	return right.join("\n");
}

export function getGitChangeType(status: string): GitChangeType {
	switch (status) {
		case "removed":
			return GitChangeType.DELETE;

		case "added":
			return GitChangeType.ADD;

		case "renamed":
			return GitChangeType.RENAME;

		case "modified":
			return GitChangeType.MODIFY;

		default:
			return GitChangeType.UNKNOWN;
	}
}

export async function parseDiff(
	reviews: IRawFileChange[],
	parentCommit: string,
): Promise<(InMemFileChange | SlimFileChange)[]> {
	const fileChanges: (InMemFileChange | SlimFileChange)[] = [];

	for (let i = 0; i < reviews.length; i++) {
		const review = reviews[i];

		const gitChangeType = getGitChangeType(review.status);

		if (
			!review.patch &&
			gitChangeType !== GitChangeType.RENAME &&
			gitChangeType !== GitChangeType.MODIFY &&
			// We don't need to make a SlimFileChange for empty file adds.
			!(gitChangeType === GitChangeType.ADD && review.additions === 0)
		) {
			fileChanges.push(
				new SlimFileChange(
					parentCommit,
					review.blob_url,
					gitChangeType,
					review.filename,
					review.previous_filename,
				),
			);

			continue;
		}

		const diffHunks = review.patch ? parsePatch(review.patch) : undefined;
		fileChanges.push(
			new InMemFileChange(
				parentCommit,
				gitChangeType,
				review.filename,
				review.previous_filename,
				review.patch ?? "",
				diffHunks,
				review.blob_url
			),
		);
	}

	return fileChanges;
}
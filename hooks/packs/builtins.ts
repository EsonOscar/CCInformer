import { NODE_VITE } from './node-vite'
import type { PackManifest } from './types'

// Every built-in, in the order detection tries them. A new built-in is a file of its own in this folder plus one
// entry here.
export const BUILTINS: PackManifest[] = [NODE_VITE]

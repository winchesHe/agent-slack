import dotenv from 'dotenv'
import path from 'node:path'
import { loadWorkspaceEnv } from '@/workspace/loadEnv.ts'

const workspaceDir = process.cwd()

loadWorkspaceEnv({ workspaceDir })
dotenv.config({ path: path.join(workspaceDir, '.env.e2e'), override: true })

import { InMemoryRunRepository } from '../src/repository/in-memory.js'
import { describeRunRepositoryContract } from './repository-contract.js'

describeRunRepositoryContract('InMemoryRunRepository', () => new InMemoryRunRepository())

import { FlamelinkContentFactory } from '@flamelink/sdk-content-types'

const factory: FlamelinkContentFactory = context => {
  console.log('content from cf', context)

  return {
    get: () => {},
    getByField: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    set: () => {}, // TODO: Consider replacing with `add`
    update: () => {},
    remove: () => {},
    transaction: () => {},
    ref: () => {}
  }
}

export default factory

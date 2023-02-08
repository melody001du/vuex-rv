import Module from './module'
import { assert, forEachValue } from '../util'

export default class ModuleCollection {
  constructor (rawRootModule) {
    // register root module (Vuex.Store options)
    this.register([], rawRootModule, false)
  }
  // path是要获取的module路径，返回指定的module
  get (path) {
    return path.reduce((module, key) => {
      return module.getChild(key)
    }, this.root)
  }
  // 根据path(每个module对象注册时的key,获取改module的路径)
  getNamespace (path) {
    let module = this.root
    return path.reduce((namespace, key) => {
      module = module.getChild(key)
      return namespace + (module.namespaced ? key + '/' : '')
    }, '')
  }
  // 热更新相关,会根据最新module配置,重新初始化store
  update (rawRootModule) {
    update([], this.root, rawRootModule)
  }
  // 递归注册每一个module
  register (path, rawModule, runtime = true) {
    // dev环境下进行类型断言，判断module选项是否正确（getters、mutations、actions）
    if (__DEV__) {
      assertRawModule(path, rawModule)
    }
    // 管理module,rawModule即为传递给createStore的module选项
    const newModule = new Module(rawModule, runtime)
    // 首次创建module
    if (path.length === 0) {
      this.root = newModule
    } else {
      // path.slice(0, -1)返回除了最后一位的结果
      // this.get获取当前路径的父module
      const parent = this.get(path.slice(0, -1))
      // 将新的module添加进整个store对象中，挂在父module下的_children属性下
      // 多个module路径会被转化为['x','xx',...]格式,根据最后一位注册module，即使用时开发者写好的名称{...,modules:{a:...,b:...}}
      parent.addChild(path[path.length - 1], newModule)
    }

    // register nested modules
    // 如果传递了modules,递归挂载,会走上面的parent.addChild逻辑
    if (rawModule.modules) {
      forEachValue(rawModule.modules, (rawChildModule, key) => {
        this.register(path.concat(key), rawChildModule, runtime)
      })
    }
  }

  // 卸载module
  unregister (path) {
    // 获取当前路径的父module
    const parent = this.get(path.slice(0, -1))
    const key = path[path.length - 1]
    const child = parent.getChild(key)

    if (!child) {
      if (__DEV__) {
        console.warn(
          `[vuex] trying to unregister module '${key}', which is ` +
          `not registered`
        )
      }
      return
    }

    if (!child.runtime) {
      return
    }
    // 从父的 this._children 对象上删掉该 key
    parent.removeChild(key)
  }

  isRegistered (path) {
    const parent = this.get(path.slice(0, -1))
    const key = path[path.length - 1]

    if (parent) {
      return parent.hasChild(key)
    }

    return false
  }
}
// 递归更新module配置,如果加入了新的module,需要手动刷新,主要是热更新中使用
function update (path, targetModule, newModule) {
  if (__DEV__) {
    assertRawModule(path, newModule)
  }

  // update target module
  targetModule.update(newModule)

  // update nested modules
  if (newModule.modules) {
    for (const key in newModule.modules) {
      if (!targetModule.getChild(key)) {
        if (__DEV__) {
          console.warn(
            `[vuex] trying to add a new module '${key}' on hot reloading, ` +
            'manual reload is needed'
          )
        }
        return
      }
      update(
        path.concat(key),
        targetModule.getChild(key),
        newModule.modules[key]
      )
    }
  }
}

const functionAssert = {
  assert: value => typeof value === 'function',
  expected: 'function'
}

const objectAssert = {
  assert: value => typeof value === 'function' ||
    (typeof value === 'object' && typeof value.handler === 'function'),
  expected: 'function or object with "handler" function'
}

const assertTypes = {
  getters: functionAssert,
  mutations: functionAssert,
  actions: objectAssert
}

function assertRawModule (path, rawModule) {
  Object.keys(assertTypes).forEach(key => {
    if (!rawModule[key]) return

    const assertOptions = assertTypes[key]

    forEachValue(rawModule[key], (value, type) => {
      assert(
        assertOptions.assert(value),
        makeAssertionMessage(path, key, type, value, assertOptions.expected)
      )
    })
  })
}

function makeAssertionMessage (path, key, type, value, expected) {
  let buf = `${key} should be ${expected} but "${key}.${type}"`
  if (path.length > 0) {
    buf += ` in module "${path.join('.')}"`
  }
  buf += ` is ${JSON.stringify(value)}.`
  return buf
}

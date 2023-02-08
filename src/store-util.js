import { reactive, computed, watch, effectScope } from 'vue'
import { forEachValue, isObject, isPromise, assert, partial } from './util'

// 收集订阅
export function genericSubscribe (fn, subs, options) {
  if (subs.indexOf(fn) < 0) {
    options && options.prepend
      ? subs.unshift(fn)
      : subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

// 重置更新整个store
export function resetStore (store, hot) {
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
  const state = store.state
  // init all modules
  installModule(store, state, [], store._modules.root, true)
  // reset state
  resetStoreState(store, state, hot, false)
}

// 进行state、getters的响应式处理
// 通过effectScope避免getters随着组件销毁而销毁
// state: reactive()、getters: computed()
export function resetStoreState (store, state, hot, reserve = true) {
  const oldState = store._state
  const oldScope = store._scope

  // bind store public getters
  store.getters = {}
  // reset local getters cache
  store._makeLocalGettersCache = Object.create(null)
  // _wrappedGetters保存module的getters
  const wrappedGetters = store._wrappedGetters
  // 保存每个getters方法
  const computedObj = {}
  // 保存每个getters方法的计算结果
  const computedCache = {}

  // create a new effect scope and create computed object inside it to avoid
  // getters (computed) getting destroyed on component unmount.
  const scope = effectScope(true)

  scope.run(() => {
    forEachValue(wrappedGetters, (fn, key) => {
      // use computed to leverage its lazy-caching mechanism
      // direct inline function use will lead to closure preserving oldState.
      // using partial to return function with only arguments preserved in closure environment.
      // 通过闭包每次获取最新的store
      computedObj[key] = partial(fn, store)
      computedCache[key] = computed(() => computedObj[key]())
      // store.getters是给外部通过store直接调用getters的
      Object.defineProperty(store.getters, key, {
        get: () => computedCache[key].value,
        enumerable: true // for local getters
      })
    })
  })

  store._state = reactive({
    data: state
  })

  // register the newly created effect scope to the store so that we can
  // dispose the effects when this method runs again in the future.
  store._scope = scope

  // enable strict mode for new state
  if (store.strict) {
    enableStrictMode(store)
  }

  if (oldState) {
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      store._withCommit(() => {
        oldState.data = null
      })
    }
  }

  // dispose previously registered effect scope if there is one.
  if (oldScope) {
    if (reserve) {
      const deadEffects = []
      // 因为如果直接oldScope.stop(),原来数据的依赖性deps也会被清空,造成响应丢失,通过registerModule添加新module的时候会出问题
      oldScope.effects.forEach(effect => {
        if (effect.deps.length) {
        // Merge the effect that already have dependencies and prevent from being killed.
          scope.effects.push(effect)
        } else {
        // Collect the dead effects.
          deadEffects.push(effect)
        }
      })
      // Dispose the dead effects.
      oldScope.effects = deadEffects
    }
    oldScope.stop()
  }
}

export function installModule (store, rootState, path, module, hot) {
  const isRoot = !path.length
  // 获取命名空间,格式为:x/xx/,选项没有设置namespaced则返回''
  // 所以格式可能有四种情况: x/xx/、 x/xx/'' 、 x/xx/''/xxx/ 、''
  // 注意上面的''只是进行说明，实际拼接''不会改变字符串,则上面实际上为：x/xx/、 x/xx/ 、 x/xx/xxx/ 、空字符串
  const namespace = store._modules.getNamespace(path)

  // register in namespace map
  // 如果声明了 namespaced 属性
  if (module.namespaced) {
    // 校验是否有重复声明的module
    if (store._modulesNamespaceMap[namespace] && __DEV__) {
      console.error(`[vuex] duplicate namespace ${namespace} for the namespaced module ${path.join('/')}`)
    }
    store._modulesNamespaceMap[namespace] = module
  }

  // set state
  // 根据module的key添加新module的state到父state下，以及校验module的key是否和父module state某个属性相同
  if (!isRoot && !hot) {
    // 获取给定path下的state,path.slice(0, -1)返回父module的路径
    const parentState = getNestedState(rootState, path.slice(0, -1))
    const moduleName = path[path.length - 1]
    store._withCommit(() => {
      if (__DEV__) {
        // 校验添加的module key是否和父state中的某个属性key相同,相同会覆盖掉
        if (moduleName in parentState) {
          console.warn(
            `[vuex] state field "${moduleName}" was overridden by a module with the same name at "${path.join('.')}"`
          )
        }
      }
      // 将新module的state,根据module对象的key,添加进父state对象中
      parentState[moduleName] = module.state
    })
  }

  // 为module创建一个局部上下文，用于当前module调用action等时，不用手动添加上级module的路径前缀
  const local = module.context = makeLocalContext(store, namespace, path)

  module.forEachMutation((mutation, key) => {
    // key 是mutation定义时的命名
    const namespacedType = namespace + key
    registerMutation(store, namespacedType, mutation, local)
  })

  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key
    registerGetter(store, namespacedType, getter, local)
  })

  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 */
// 主要作用是为module内部调用actions等时，根据是否有namespaced,为调用的type拼接对应module注册时对应操作的前缀路径
// 比如调用时type:'a',则实际上为: moduleA/a
function makeLocalContext (store, namespace, path) {
  const noNamespace = namespace === ''
  // 区分有命名空间和无命名空间的提交方式，有:type = namespace + type,无:直接使用type（会和操作根module一样）
  // 因为installModule中获取namespace,如果module没有声明namespaced,则不会添加该module的key到namespace
  // 通过registerMutation等进行注册时也不会有module的key
  // 则module内部调用则需要父namespace+type进行调用,如果有namespaced,module内调用只需要type即可
  // 如果嵌套的module都没有声明namespace,则相当于操作根module
  const local = {
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => { // 会自动在type前+namespace,module内调用只需要type即可
      // 统一提交格式（兼容第一个参数为对象的写法）
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }
      // 帮助拼接前缀路径
      return store.dispatch(type, payload)
    },
    // 和dispatch同理
    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      store.commit(type, payload, options)
    }
  }

  // getters and state object must be gotten lazily
  // because they will be changed by state update
  // store.getters 和 store.state 都是在 resetStoreState 中定义
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
        // 内部通过Object.defineProperty指向store.getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  })

  return local
}
// 所有getters都会放在store.getters上，通过resetStoreState
// 过滤出namespace下的getters，为当前module创建一个局部对象进行拦截
// 访问局部对象时，实际通过store.getters进行调用
export function makeLocalGetters (store, namespace) {
  if (!store._makeLocalGettersCache[namespace]) {
    const gettersProxy = {}
    const splitPos = namespace.length
    // 所有getters都会放在store.getters上，通过resetStoreState
    Object.keys(store.getters).forEach(type => {
      // skip if the target getter is not match this namespace
      //  只匹配对应namespace下的getters
      if (type.slice(0, splitPos) !== namespace) return

      // extract local getter type
      // 获取getter的定义名称
      const localType = type.slice(splitPos)

      // Add a port to the getters proxy.
      // Define as getter property because
      // we do not want to evaluate the getters in this time.
      // 通过Object.defineProperty实际调用指向store.getters[type]
      // 这里还要添一层代理是因为,store.getters已经被Object.defineProperty代理了(在resetStoreState中)
      // 如果这里直接store.getters则会触发getters,而这里只是想做个本地module的注册
      Object.defineProperty(gettersProxy, localType, {
        get: () => store.getters[type],
        enumerable: true
      })
    })
    store._makeLocalGettersCache[namespace] = gettersProxy
  }

  return store._makeLocalGettersCache[namespace]
}

// 注册mutation
function registerMutation (store, type, handler, local) {
  const entry = store._mutations[type] || (store._mutations[type] = [])
  // 这里是push,意味着相同type的mutaion会一并触发,并不会覆盖
  entry.push(function wrappedMutationHandler (payload) {
    handler.call(store, local.state, payload)
  })
}
// 注册action,调用结果使用Promise.resolve包装
function registerAction (store, type, handler, local) {
  const entry = store._actions[type] || (store._actions[type] = [])
  // 这里是action,意味着相同type的action会一并触发,并不会覆盖
  entry.push(function wrappedActionHandler (payload) {
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      rootGetters: store.getters,
      rootState: store.state
    }, payload)
    if (!isPromise(res)) {
      res = Promise.resolve(res)
    }
    if (store._devtoolHook) {
      return res.catch(err => {
        store._devtoolHook.emit('vuex:error', err)
        throw err
      })
    } else {
      return res
    }
  })
}

// getter注册链:
// 首先makeLocalGettersstore._makeLocalGettersCache 每个module局部保存的getters
// -> registerGetter -> store._wrappedGetters 注册到整个store.getters上去

// 注册getter，保存到全局store上
function registerGetter (store, type, rawGetter, local) {
  if (store._wrappedGetters[type]) {
    if (__DEV__) {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }
  // 这里的store会在resetStoreState中传入
  store._wrappedGetters[type] = function wrappedGetter (store) {
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

// 判断是否是通过_withCommit修改,即不是外部直接修改state,通过_committing
function enableStrictMode (store) {
  watch(() => store._state.data, () => {
    if (__DEV__) {
      assert(store._committing, `do not mutate vuex store state outside mutation handlers.`)
    }
  }, { deep: true, flush: 'sync' })
}

export function getNestedState (state, path) {
  return path.reduce((state, key) => state[key], state)
}

// 统一提交格式（兼容第一个参数为对象的写法）
export function unifyObjectStyle (type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  if (__DEV__) {
    assert(typeof type === 'string', `expects string as the type, but found ${typeof type}.`)
  }

  return { type, payload, options }
}

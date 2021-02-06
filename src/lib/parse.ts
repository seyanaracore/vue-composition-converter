import * as ts from 'typescript'
import { parseComponent } from 'vue-template-compiler'

export const parse = (input: string) => {
  const parsed = parseComponent(input)
  const scriptContent = parsed.script?.content || ''
  const sourceFile = ts.createSourceFile(
    '',
    scriptContent,
    ts.ScriptTarget.Latest
  )
  return convertScript(sourceFile)
}

const convertScript = (sourceFile: ts.SourceFile) => {
  const result = ts.transform(sourceFile, [transformer])
  const printer = ts.createPrinter()
  return result.transformed.map((src) => printer.printFile(src)).join('')
}

const replaceContext = (str: string) => {
  return str
    .replace(/this\.\$/g, 'ctx.root.$')
    .replace(/this\.([\w-]+)/g, `$1.value`)
}

const getNodeByKind = (node: ts.Node, kind: ts.SyntaxKind): ts.Node[] => {
  const list: ts.Node[] = []
  const search = (node: ts.Node) => {
    if (node.kind === kind) {
      list.push(node)
    }
    ts.forEachChild(node, (child) => {
      search(child)
    })
  }
  search(node)
  return list
}

type ConvertedExpression = {
  expression: string
  name?: string
}

const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
  return (sourceFile) => {
    let inExport = false
    let inExportObject = false

    const exportDefaultVisitor = (node: ts.Node): ts.Node => {
      const identifier = ts.factory.createIdentifier('defineComponent')

      // export default Vue.extend({})
      if (ts.isCallExpression(node)) {
        node = ts.factory.updateCallExpression(
          node,
          identifier,
          node.typeArguments,
          node.arguments
        )
      }
      // export default {}
      else if (ts.isObjectLiteralExpression(node)) {
        node = ts.factory.createCallExpression(identifier, undefined, [node])
      }
      return node
    }

    const visitor = (node: ts.Node): ts.Node => {
      if (ts.isExportAssignment(node)) {
        // export default
        inExport = true
        node = ts.visitEachChild(node, exportDefaultVisitor, context)
      } else if (inExport) {
        if (!inExportObject) {
          if (ts.isObjectLiteralExpression(node)) {
            // export default Vue.extend({ })
            inExportObject = true

            const otherProps: ts.ObjectLiteralElementLike[] = []
            const setupProps = []

            for (const prop of node.properties) {
              const name = prop.name?.getText(sourceFile)
              switch (name) {
                case 'data':
                  // console.log(getObjectLiteralVisitor(prop))
                  setupProps.unshift(...dataConverter(prop, sourceFile))
                  break
                case 'computed':
                  setupProps.push(...computedConverter(prop, sourceFile))

                  break
                case 'methods':
                  if (!ts.isPropertyAssignment(prop)) continue
                  // console.log(prop.initializer)
                  break
                case 'watch':
                  break
                case 'beforeCreate':
                case 'created':
                case 'beforeMount':
                case 'mounted':
                case 'beforeUpdate':
                case 'updated':
                case 'beforeDetroy':
                case 'activated':
                case 'deactivated':
                  setupProps.push(...lifeCycleConverter(name, prop, sourceFile))
                  break
                default:
                  otherProps.push(prop)
                  break
              }
              // console.log(prop)
              // return name !== 'data'
            }
            // return setup

            const returnStatement = `return {${setupProps
              .map(({ name }) => name)
              .join(',')}}`

            const setupStatements = [
              ...setupProps,
              { expression: returnStatement },
            ]
              .map(
                ({ expression }) =>
                  ts.createSourceFile('', expression, ts.ScriptTarget.Latest)
                    .statements
              )
              .flat()

            // console.log(setupProps, setupStatements)

            const setup = ts.factory.createMethodDeclaration(
              undefined,
              undefined,
              undefined,
              'setup',
              undefined,
              undefined,
              [
                ts.factory.createParameterDeclaration(
                  undefined,
                  undefined,
                  undefined,
                  '_props'
                ),
                ts.factory.createParameterDeclaration(
                  undefined,
                  undefined,
                  undefined,
                  'ctx'
                ),
              ],
              undefined,
              ts.factory.createBlock(setupStatements)
            )
            // return node
            const ex = ts.factory.createObjectLiteralExpression([
              ...otherProps,
              setup,
            ])

            return ex
          }
        }
      }

      return ts.visitEachChild(node, visitor, context)
    }

    return ts.visitNode(sourceFile, visitor)
  }
}

const storePath = `ctx.root.$store`

const lifeCycleConverter = (
  lifeCycle: string,
  node: ts.Node,
  sourceFile: ts.SourceFile
): ConvertedExpression[] => {
  if (!ts.isMethodDeclaration(node)) return []

  const apiMap = {
    beforeMount: 'onBeforeMount',
    mounted: 'onMounted',
    beforeUpdate: 'onBeforeUpdate',
    updated: 'onUpdated',
    beforeUnmount: 'onBeforeUnmount',
    unmounted: 'onUnmounted',
    errorCaptured: 'onErrorCaptured',
    renderTracked: 'onRenderTracked',
    renderTriggered: 'onRenderTriggered',
  }
  // @ts-expect-error
  const setupLifeCyle = apiMap[lifeCycle]
  const body = replaceContext(node.body?.getText(sourceFile) || '{}')
  if (setupLifeCyle != null) {
    return [{ expression: `${setupLifeCyle}(()=>${body})` }]
  }

  return [{ expression: `(()=>${body})()` }]
}

const getInitializerProps = (node: ts.Node): ts.ObjectLiteralElementLike[] => {
  if (!ts.isPropertyAssignment(node)) return []
  if (!ts.isObjectLiteralExpression(node.initializer)) return []
  return [...node.initializer.properties]
}

const dataConverter = (
  node: ts.Node,
  sourceFile: ts.SourceFile
): ConvertedExpression[] => {
  const [objNode] = getNodeByKind(node, ts.SyntaxKind.ObjectLiteralExpression)

  if (!(objNode && ts.isObjectLiteralExpression(objNode))) return []
  return objNode.properties
    .map((prop) => {
      if (!ts.isPropertyAssignment(prop)) return
      const name = prop.name.getText(sourceFile)
      const text = prop.initializer.getText(sourceFile)
      return { expression: `const ${name} = ref(${text})`, name }
    })
    .filter((item): item is NonNullable<typeof item> => item != null)
}

const computedConverter = (
  node: ts.Node,
  sourceFile: ts.SourceFile
): ConvertedExpression[] => {
  return getInitializerProps(node)
    .map((prop) => {
      if (ts.isSpreadAssignment(prop)) {
        // mapGetters, mapState, mapActions
        if (!ts.isCallExpression(prop.expression)) return
        const { arguments: args, expression } = prop.expression

        if (!ts.isIdentifier(expression)) return
        const mapName = expression.text
        const [namespace, mapArray] = args
        if (!ts.isStringLiteral(namespace)) return
        if (!ts.isArrayLiteralExpression(mapArray)) return

        const namespaceText = namespace.text
        const names = mapArray.elements as ts.NodeArray<ts.StringLiteral>

        switch (mapName) {
          case 'mapState':
            return names.map(({ text: name }) => {
              return {
                expression: `const ${name} = computed(() => ${storePath}.state.${namespaceText}.${name})`,
                name,
              }
            })
          case 'mapGetters':
            return names.map(({ text: name }) => {
              return {
                expression: `const ${name} = computed(() => ${storePath}.getters['${namespaceText}/${name}'])`,
                name,
              }
            })
          case 'mapActions':
            return names.map(({ text: name }) => {
              return {
                expression: `const ${name} = () => ${storePath}.dispatch('${namespaceText}/${name}')`,
                name,
              }
            })
        }
        return null
      } else if (ts.isMethodDeclaration(prop)) {
        const { name: propName, body, type } = prop
        const typeName = type ? `:${type.getText(sourceFile)}` : ''
        const block = replaceContext(body?.getText(sourceFile) || '{}')
        const name = propName.getText(sourceFile)

        return { expression: `const ${name} = ()${typeName} => ${block}`, name }
      } else if (ts.isPropertyAssignment(prop)) {
      }
    })
    .flat()
    .filter((item): item is NonNullable<typeof item> => item != null)
}

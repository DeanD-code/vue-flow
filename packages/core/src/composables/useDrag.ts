import type { D3DragEvent, DragBehavior, SubjectPosition } from 'd3-drag'
import { drag } from 'd3-drag'
import { select } from 'd3-selection'
import type { Ref } from 'vue'
import { ref, watch } from 'vue'
import type { MaybeRefOrGetter } from '@vueuse/core'
import { toValue } from '@vueuse/core'
import { useGetPointerPosition, useVueFlow } from '.'
import {
  calcAutoPan,
  calcNextPosition,
  getDragItems,
  getEventHandlerParams,
  getEventPosition,
  handleNodeClick,
  hasSelector,
} from '~/utils'
import type { NodeDragEvent, NodeDragItem, XYPosition } from '~/types'

export type UseDragEvent = D3DragEvent<HTMLDivElement, null, SubjectPosition>

interface UseDragParams {
  onStart: (args: Omit<NodeDragEvent, 'intersections'>) => void
  onDrag: (event: Omit<NodeDragEvent, 'intersections'>) => void
  onStop: (event: Omit<NodeDragEvent, 'intersections'>) => void
  el: Ref<Element | null>
  disabled?: MaybeRefOrGetter<boolean>
  selectable?: MaybeRefOrGetter<boolean>
  dragHandle?: MaybeRefOrGetter<string | undefined>
  id?: string
}

export function useDrag(params: UseDragParams) {
  const {
    vueFlowRef,
    snapToGrid,
    snapGrid,
    noDragClassName,
    nodes,
    nodeExtent,
    viewport,
    autoPanOnNodeDrag,
    nodesDraggable,
    panBy,
    findNode,
    multiSelectionActive,
    nodesSelectionActive,
    selectNodesOnDrag,
    removeSelectedElements,
    addSelectedNodes,
    updateNodePositions,
    emits,
  } = useVueFlow()

  const { onStart, onDrag, onStop, el, disabled, id, selectable, dragHandle } = params

  const dragging = ref(false)

  let dragItems: NodeDragItem[] = []

  let dragHandler: DragBehavior<Element, unknown, unknown>

  let containerBounds: DOMRect | null = null

  let lastPos: Partial<XYPosition> = { x: undefined, y: undefined }
  let mousePosition: XYPosition = { x: 0, y: 0 }
  let dragEvent: MouseEvent | null = null

  let autoPanId = 0
  let autoPanStarted = false

  const getPointerPosition = useGetPointerPosition()

  const updateNodes = ({ x, y }: XYPosition) => {
    lastPos = { x, y }

    let hasChange = false

    dragItems = dragItems.map((n) => {
      const nextPosition = { x: x - n.distance.x, y: y - n.distance.y }

      if (snapToGrid.value) {
        nextPosition.x = snapGrid.value[0] * Math.round(nextPosition.x / snapGrid.value[0])
        nextPosition.y = snapGrid.value[1] * Math.round(nextPosition.y / snapGrid.value[1])
      }

      const { computedPosition } = calcNextPosition(
        n,
        nextPosition,
        emits.error,
        nodeExtent.value,
        n.parentNode ? findNode(n.parentNode) : undefined,
      )

      // we want to make sure that we only fire a change event when there is a change
      hasChange = hasChange || n.position.x !== computedPosition.x || n.position.y !== computedPosition.y

      n.position = computedPosition

      return n
    })

    if (!hasChange) {
      return
    }

    updateNodePositions(dragItems, true, true)

    dragging.value = true

    if (dragEvent) {
      const [currentNode, nodes] = getEventHandlerParams({
        id,
        dragItems,
        findNode,
      })

      onDrag({ event: dragEvent, node: currentNode, nodes })
    }
  }

  const autoPan = (): void => {
    if (!containerBounds) {
      return
    }

    const [xMovement, yMovement] = calcAutoPan(mousePosition, containerBounds)

    if (xMovement !== 0 || yMovement !== 0) {
      const nextPos = {
        x: (lastPos.x ?? 0) - xMovement / viewport.value.zoom,
        y: (lastPos.y ?? 0) - yMovement / viewport.value.zoom,
      }

      if (panBy({ x: xMovement, y: yMovement })) {
        updateNodes(nextPos)
      }
    }

    autoPanId = requestAnimationFrame(autoPan)
  }

  watch([() => toValue(disabled), el], ([isDisabled, nodeEl]) => {
    if (nodeEl) {
      const selection = select(nodeEl)

      if (isDisabled) {
        selection.on('.drag', null)
      } else {
        dragHandler = drag()
          .on('start', (event: UseDragEvent) => {
            const node = findNode(id)
            if (!selectNodesOnDrag.value && !multiSelectionActive.value && node) {
              if (!node.selected) {
                // we need to reset selected nodes when selectNodesOnDrag=false
                removeSelectedElements()
              }
            }

            if (node && toValue(selectable) && selectNodesOnDrag.value) {
              handleNodeClick(
                node,
                multiSelectionActive.value,
                addSelectedNodes,
                removeSelectedElements,
                nodesSelectionActive,
                false,
                nodeEl as HTMLDivElement,
              )
            }

            const pointerPos = getPointerPosition(event)
            lastPos = pointerPos
            dragItems = getDragItems(nodes.value, nodesDraggable.value, pointerPos, findNode, id)

            if (dragItems.length) {
              const [currentNode, nodes] = getEventHandlerParams({
                id,
                dragItems,
                findNode,
              })

              onStart({ event: event.sourceEvent, node: currentNode, nodes })
            }

            containerBounds = vueFlowRef.value?.getBoundingClientRect() || null
            mousePosition = getEventPosition(event.sourceEvent, containerBounds!)
          })
          .on('drag', (event: UseDragEvent) => {
            const pointerPos = getPointerPosition(event)

            if (!autoPanStarted && autoPanOnNodeDrag.value) {
              autoPanStarted = true
              autoPan()
            }

            // skip events without movement
            if ((lastPos.x !== pointerPos.xSnapped || lastPos.y !== pointerPos.ySnapped) && dragItems.length) {
              dragEvent = event.sourceEvent as MouseEvent
              mousePosition = getEventPosition(event.sourceEvent, containerBounds!)

              updateNodes(pointerPos)
            }
          })
          .on('end', (event: UseDragEvent) => {
            dragging.value = false
            autoPanStarted = false
            cancelAnimationFrame(autoPanId)

            if (dragItems.length) {
              updateNodePositions(dragItems, false, false)

              const [currentNode, nodes] = getEventHandlerParams({
                id,
                dragItems,
                findNode,
              })

              onStop({ event: event.sourceEvent, node: currentNode, nodes })
            }
          })
          .filter((event: D3DragEvent<HTMLDivElement, null, SubjectPosition>['sourceEvent']) => {
            const target = event.target as HTMLDivElement
            const unrefDragHandle = toValue(dragHandle)

            return (
              !event.button &&
              (!noDragClassName.value ||
                (!hasSelector(target, `.${noDragClassName.value}`, nodeEl) &&
                  (!unrefDragHandle || hasSelector(target, unrefDragHandle, nodeEl))))
            )
          })

        selection.call(dragHandler)
      }
    }
  })

  return dragging
}

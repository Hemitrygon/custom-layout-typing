# keyboard.blend のキーボード（KB_Root の下）を glb に書き出す（.blend は保存しない）。tools/export_keyboard.sh から呼ぶ
#   blender -b keyboard.blend --python export_keyboard.py -- 出力.glb [draco]
import bpy, sys
args = sys.argv[sys.argv.index('--') + 1:]
out, draco = args[0], ('draco' in args[1:])
root = bpy.data.objects['KB_Root']
bpy.ops.object.select_all(action='DESELECT')
picked = [o for o in root.children_recursive if o.type == 'MESH' and not o.hide_render] + [root]
for o in picked:
    o.hide_set(False); o.select_set(True)
print('== picked', len(picked))
bpy.ops.export_scene.gltf(filepath=out, use_selection=True, export_apply=True,
                          export_animations=False, export_draco_mesh_compression_enable=draco)

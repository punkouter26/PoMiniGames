import re
c = open(r'src\PoMiniGames.Client\wwwroot\games\pogallery\models\chair\createObjectModel.js', encoding='utf-8').read()
# Find lines like: const mesh_X = new THREE.Mesh(mesh_XGeometry, materialMap["frame"] ...);
pat = re.compile(r'new THREE\.Mesh\(mesh_(\w+)Geometry,\s*materialMap\["(\w+)"\]')
for m in pat.finditer(c):
    print('mesh:', m.group(1), '-> materialMap[', m.group(2), ']')

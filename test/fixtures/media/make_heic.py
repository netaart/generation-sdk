import sys

import pillow_heif
from PIL import Image

pillow_heif.register_heif_opener()
Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], quality=60)

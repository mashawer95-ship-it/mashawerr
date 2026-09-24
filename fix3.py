import codecs
import re
import os

filePath = os.path.join(os.path.dirname(__file__), 'Controllers', 'orderController.js')
with codecs.open(filePath, 'r', 'utf-8') as f:
    text = f.read()

# Replace all formatOrder calls
text = text.replace('formatOrder(order)', 'formatOrder(req, order)')
text = text.replace('formatOrder(o)', 'formatOrder(req, o)')
# Fix the declaration which got accidentally replaced to function formatOrder(req, req, order) if it was function formatOrder(order)
text = text.replace('function formatOrder(req, req, order)', 'function formatOrder(req, order)')
text = text.replace('function formatOrder(req, order)', 'function formatOrder(req, order)')

with codecs.open(filePath, 'w', 'utf-8') as f:
    f.write(text)

print("Fixed formatOrder usages!")

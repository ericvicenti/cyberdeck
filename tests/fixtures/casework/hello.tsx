import React from 'react';
import { Text } from 'react-native';
import { useRuntime } from '@remote/runtime';
export default function Hello() { const rt = useRuntime(); return <Text>hello {rt.status}</Text>; }

import { TestBed } from '@angular/core/testing';

import { Statements } from './statements';

describe('Statements', () => {
  let service: Statements;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Statements);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
